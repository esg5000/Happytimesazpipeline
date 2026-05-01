"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.main = main;
const grammy_1 = require("grammy");
const config_1 = require("./config");
const telegramBotCore_1 = require("./telegramBotCore");
async function main() {
    (0, config_1.validateConfig)();
    (0, config_1.validateTelegramBaseConfig)();
    const bot = new grammy_1.Bot(config_1.config.telegram.botToken);
    (0, telegramBotCore_1.registerTelegramHandlers)(bot);
    // In polling mode we clear webhook so updates are delivered to getUpdates.
    await bot.api.deleteWebhook({ drop_pending_updates: false });
    await bot.start();
    console.log('Telegram polling dev bot started');
}
if (require.main === module) {
    main().catch((err) => {
        console.error('Fatal Telegram polling error:', err);
        process.exit(1);
    });
}
//# sourceMappingURL=telegramPollingDev.js.map