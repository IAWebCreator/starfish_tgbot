import { BotManagerService } from './services/botManagerService';
import express from 'express';

let botManager: BotManagerService;
// Single PORT declaration with proper type conversion
const PORT = parseInt(process.env.PORT || '3000', 10);

async function startBotSystem() {
    const app = express();
    botManager = new BotManagerService();

    try {
        // Start express server first to ensure port binding
        const server = app.listen(PORT, '0.0.0.0', () => {
            console.log(`Server is running on port ${PORT}`);
        });

        // Setup express routes
        app.get('/', (req, res) => {
            res.send('Bot is running!');
        });

        // Initialize bots after server is running
        await botManager.initializeBots();
        console.log('Bot system initialized successfully');

        // Enable graceful stop
        process.once('SIGINT', () => gracefulShutdown(server));
        process.once('SIGTERM', () => gracefulShutdown(server));

    } catch (error) {
        console.error('Error starting bot system:', error);
        await gracefulShutdown();
        process.exit(1);
    }
}

async function gracefulShutdown(server?: any) {
    console.log('Shutdown signal received. Cleaning up...');
    if (server) {
        server.close(() => {
            console.log('Server closed');
        });
    }
    if (botManager) {
        await botManager.cleanup();
    }
    process.exit(0);
}

// Start the system
startBotSystem().catch(error => {
    console.error('Failed to start system:', error);
    process.exit(1);
}); 