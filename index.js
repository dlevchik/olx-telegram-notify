require('dotenv').config();
const rp = require('request-promise');
const cheerio = require('cheerio');
const log = require('simple-node-logger').createSimpleLogger('script.log');
const schedule = require('node-schedule');
const sqlite3 = require('sqlite3').verbose();

const ENTRY_LIST_URL = process.env.ENTRY_LIST_URL;
const TELEGRAM_BOT_URL = 'https://api.telegram.org/bot' + process.env.TELEGRAM_BOT_API_KEY;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_TARGET_CHAT_ID;
const delay_ms = 5000;

const db = new sqlite3.Database('db.sqllite', (err) => {
    if (err) {
        return log.error(err);
    }
    log.info('Open connection to create initial table if it not exists');
});
db.run('CREATE TABLE IF NOT EXISTS advertisements(adv_id INTEGER NOT NULL UNIQUE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL )');
db.close((err) => {
    if (err) {
        return log.error(err);
    }
    log.info('Close the database connection.');

    log.info('Scheduling job... Script will catch advertisements every minute.')
    const job = schedule.scheduleJob('* * * * *', function () {
        parseListPage(ENTRY_LIST_URL);
    });
});

function parseListPage(pageUrl) {
    log.info('Started parsing list page...');
    rp(pageUrl)
        .then(async function(html) {
            const list_page = cheerio.load(html);

            // Receive all advertisements from list.
            const advertisements = list_page('.listing-grid-container [data-cy="l-card"]');
            const db = new sqlite3.Database('db.sqllite', (err) => {
                if (err) {
                    return log.error(err);
                }
                log.info('Connected to the in-memory SQlite database.');
            });

            const processed_advertisements_ids = await db_all(db, 'SELECT adv_id FROM advertisements ORDER BY created_at DESC LIMIT 100')
                .then(function (db_objects) {
                    return db_objects.map(function(value,index) { return value.adv_id; });
                });

            let new_advertisements_list = [];
            let new_advertisiments_ids = [];
            for (let advertisement_elem of advertisements) {
                const advertisement = cheerio.load(advertisement_elem);

                // Filter out the ones promoted.
                if (advertisement('[data-testid="adCard-featured"]').length) {
                    continue;
                }

                const advertisiment_id = parseInt(advertisement_elem.attribs.id);
                if (processed_advertisements_ids.includes(advertisiment_id)) {
                    log.info(`Found already processed advertisiment ${advertisiment_id}, breaking`)
                    break;
                }

                const advertisement_url = 'https://www.olx.ua' + advertisement('a').attr('href');

                const advertisement_data = await parseAdvertisementPage(advertisement_url);

                new_advertisements_list.push(advertisement_data);
                new_advertisiments_ids.push(advertisiment_id);
            }

            if (new_advertisiments_ids.length) {
                db.run(`INSERT INTO advertisements(adv_id) VALUES(?)`, new_advertisiments_ids, function(err) {
                    if (err) {
                        return log.error(err);
                    }
                    log.log(`A row has been inserted for advertisiments ${new_advertisiments_ids.join(', ')}`);
                });
            }

            let promises = [];
            let current_delay = 0;
            for (let new_advertisement of new_advertisements_list) {
                // At least 2 photos.
                if (new_advertisement.advertisement_images_urls.length <= 1) {
                    log.warn('Advertisement with 1 or less photos: ' + new_advertisement.url);
                    continue;
                }

                const msg_text = `<a href="${new_advertisement.url}">${new_advertisement.title}</a>\n<strong>${new_advertisement.price}</strong>\n\n${new_advertisement.description}`;

                let media = [];
                let processed_items = 0;
                for (const media_url of new_advertisement.advertisement_images_urls) {
                    processed_items++;

                    // Max 10 photos.
                    if (processed_items > 10) {
                        break;
                    }

                    media.push({
                        'type': 'photo',
                        'media': media_url,
                    });
                }

                media[0].caption = msg_text;
                media[0].parse_mode = 'HTML';

                promises.push(new Promise(resolve => setTimeout(resolve, current_delay))
                    .then(function () {
                       log.info('Telegram request for ' + new_advertisement.url);
                       return rp(TELEGRAM_BOT_URL + '/sendMediaGroup?chat_id=' + TELEGRAM_CHAT_ID + '&media=' + encodeURIComponent(JSON.stringify(media)))
                           .then(function (data) {
                               log.info('Sent apartment ' + new_advertisement.url + ' to telegram bot');
                           })
                           .catch(log.error);
                    }));
                current_delay += delay_ms;
            }

            Promise.all(promises).then(function () {
                db.close((err) => {
                    if (err) {
                        return log.error(err);
                    }
                    log.info('Close the database connection.');
                });
                log.info('Finished script run.');
            });
        })
        .catch(function(err){
            log.error(err);
            return [];
        });
}

async function parseAdvertisementPage(advertisementUrl) {
    return rp(advertisementUrl)
        .then(function(html) {
            log.info('Parsed advertisement URL: ' + advertisementUrl);
            let advertisement_data = {
                url: advertisementUrl,
            };
            const advertisement_page = cheerio.load(html);

            let advertisement_images_urls = []
            for (let advertisement_image of advertisement_page('[data-cy="adPhotos-swiperSlide"] img')) {
                advertisement_images_urls.push(advertisement_image.attribs.src)
            }
            advertisement_data.advertisement_images_urls = advertisement_images_urls;

            advertisement_data.title = advertisement_page('[data-cy="ad_title"]').text();
            advertisement_data.price = advertisement_page('[data-testid="ad-price-container"] h3').text();
            advertisement_data.description = advertisement_page('[data-cy="ad_description"] > div').text();

            return advertisement_data;
        })
        .catch(function(err){
            log.error(err);
            return null;
        });
}

async function db_all(db, query){
    return new Promise(function(resolve,reject){
        db.all(query, function(err,rows){
            if(err){return reject(err);}
            resolve(rows);
        });
    });
}