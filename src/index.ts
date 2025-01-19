import { BotManagerService } from './services/botManagerService';

let botManager: BotManagerService;

async function startBotSystem() {
    botManager = new BotManagerService();

    try {
        // Initialize all existing bots
        await botManager.initializeBots();
        console.log('Bot system initialized successfully');

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