import { BotManagerService } from './services/botManagerService';
import express from 'express';

let botManager: BotManagerService;
// Convert PORT to number explicitly
const PORT = parseInt(process.env.PORT || '3000', 10);

async function startBotSystem() {
    botManager = new BotManagerService();
    const app = express();

    try {
        // Initialize all existing bots
        await botManager.initializeBots();
        console.log('Bot system initialized successfully');

        // Setup express routes
        app.get('/', (req, res) => {
            res.send('Bot is running!');
        });

        // Start express server with explicit host binding
        app.listen(PORT, '0.0.0.0', () => {
            console.log(`Server is running on port ${PORT}`);
        });

        // Enable graceful stop
        process.once('SIGINT', gracefulShutdown);
        process.once('SIGTERM', gracefulShutdown);

    } catch (error) {
        console.error('Error starting bot system:', error);
        await gracefulShutdown();
        process.exit(1);
    }
}

async function gracefulShutdown() {
    console.log('Shutdown signal received. Cleaning up...');
    if (botManager) {
        await botManager.cleanup();
    }
    process.exit(0);
}

startBotSystem(); 