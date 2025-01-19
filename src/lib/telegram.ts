import { Telegraf } from 'telegraf';
import { config } from '../config/config';

if (!config.telegram.botToken) {
    throw new Error('TELEGRAM_BOT_TOKEN must be provided!');
}

export const bot = new Telegraf(config.telegram.botToken);

// Error handling
bot.catch((err, ctx) => {
    console.error(`Error for ${ctx.updateType}`, err);
}); 