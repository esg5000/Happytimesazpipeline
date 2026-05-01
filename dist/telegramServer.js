"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.main = main;
const grammy_1 = require("grammy");
const config_1 = require("./config");
const telegramHttpServer_1 = require("./telegramHttpServer");
async function main() {
    (0, config_1.validateConfig)();
    (0, config_1.validateTelegramConfig)();
    const bot = new grammy_1.Bot(config_1.config.telegram.botToken);
    await (0, telegramHttpServer_1.startTelegramWebhookExpress)(bot);
}
if (require.main === module) {
    main().catch((err) => {
        console.error('Fatal Telegram server error:', err);
        process.exit(1);
    });
}
//# sourceMappingURL=telegramServer.js.map