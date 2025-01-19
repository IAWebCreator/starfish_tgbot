import dotenv from 'dotenv';

dotenv.config();

export const config = {
    telegram: {
        apiId: process.env.TELEGRAM_API_ID,
        apiHash: process.env.TELEGRAM_API_HASH,
        botToken: process.env.TELEGRAM_BOT_TOKEN,
    },
    supabase: {
        url: process.env.SUPABASE_URL,
        key: process.env.SUPABASE_KEY,
    },
    gemini: {
        apiKey: process.env.GEMINI_API_KEY,
    },
}; 