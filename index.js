require('dotenv').config();
const rp = require('request-promise');
const cheerio = require('cheerio');
const fs = require('fs');
const log = require('simple-node-logger').createSimpleLogger('script.log');
const schedule = require('node-schedule');

const ENTRY_LIST_URL = process.env.ENTRY_LIST_URL;
const TELEGRAM_BOT_URL = 'https://api.telegram.org/bot' + process.env.TELEGRAM_BOT_API_KEY;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_TARGET_CHAT_ID;
const delay_ms = 1200;

try {
    global.LAST_UPDATE_TIMESTAMP = parseInt(fs.readFileSync('timestamp.txt'));
} catch (err) {
    if (err.errno !== -2) {
        log.error(err);
        throw err;
    }

    log.info('Setting initial timestamp...');
    const LAST_UPDATE_TIMESTAMP = Math.floor(Date.now() / 1000);
    fs.writeFileSync('timestamp.txt', LAST_UPDATE_TIMESTAMP.toString());
    process.exit(0);
}

log.info('Scheduling job... Script will catch advertisements every minute.')
const job = schedule.scheduleJob('* * * * *', function () {
    parseListPage(ENTRY_LIST_URL);
});

function parseListPage(pageUrl) {
    log.info('Started parsing list page...');
    rp(pageUrl)
        .then(async function(html) {
            const list_page = cheerio.load(html);
            // Receive all advertisements from list. Filter out the ones promoted.
            const advertisements = list_page('.listing-grid-container [data-cy="l-card"]').filter(function( index ) {
                const advertisement = cheerio.load(this);
                return !advertisement('[data-testid="adCard-featured"]').length;
            });

            let new_advertisements_list = [];
            for (let advertisement_elem of advertisements) {
                const advertisement = cheerio.load(advertisement_elem);
                const advertisement_url = 'https://www.olx.ua' + advertisement('a').attr('href');

                const advertisement_data = await parseAdvertisementPage(advertisement_url);

                if (advertisement_data === null) {
                    break;
                }

                new_advertisements_list.push(advertisement_data);
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
                global.LAST_UPDATE_TIMESTAMP = Math.floor(Date.now() / 1000);
                fs.writeFileSync('timestamp.txt', LAST_UPDATE_TIMESTAMP.toString());
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

            let posted_at = advertisement_page('[data-cy="ad-posted-at"]').text();
            if (!posted_at.includes('Сьогодні о ')) {
                return null;
            }

            posted_at = posted_at.replace('Сьогодні о ', '');
            [hours, minutes] = posted_at.split(':');
            hours = parseInt(hours);
            minutes = parseInt(minutes);

            let date = new Date();

            let hours_now = date.getHours();
            date.setHours(hours + 3);
            date.setMinutes(minutes);

            if (hours_now <= 1 || hours_now === 23) {
                date.setDate(date.getDate() - 1);
            }

            if (Math.floor(date.getTime() / 1000) <= LAST_UPDATE_TIMESTAMP) {
                return null;
            }

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