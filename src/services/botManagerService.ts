import { Telegraf } from 'telegraf';
import { supabase } from '../lib/supabase';
import { setupActivationCommand } from '../commands/activation';
import { setupConversationalHandlers } from '../commands/conversational';
import { ConversationService } from './conversationService';
import { ActivationService } from './activationService';
import { RealtimeChannel } from '@supabase/supabase-js';
import { config } from '../config/config';

export class BotManagerService {
    private bots: Map<number, Telegraf> = new Map();
    private subscriptions: Map<number, RealtimeChannel> = new Map();
    private conversationService: ConversationService;
    private activationService: ActivationService;
    private realtimeChannel: RealtimeChannel | null = null;

    constructor() {
        // Check if bot token exists
        if (!config.telegram.botToken) {
            throw new Error('TELEGRAM_BOT_TOKEN must be provided!');
        }
        
        // Create a temporary bot instance for the ActivationService
        const defaultBot = new Telegraf(config.telegram.botToken);
        this.activationService = new ActivationService(defaultBot);
        this.conversationService = new ConversationService();
        this.setupRealtimeSubscription();
    }

    private setupRealtimeSubscription() {
        console.log('Setting up realtime subscription for bots table...');
        
        this.realtimeChannel = supabase
            .channel('bots-channel')
            .on(
                'postgres_changes',
                {
                    event: 'INSERT',
                    schema: 'public',
                    table: 'bots'
                },
                async (payload) => {
                    console.log('New bot detected:', payload);
                    const newBot = payload.new as { id: number; token_id: string };
                    
                    if (newBot.token_id) {
                        console.log(`Initializing new bot with ID: ${newBot.id}`);
                        await this.initializeBot(newBot.id, newBot.token_id);
                    } else {
                        console.warn(`Bot ${newBot.id} has no token_id, skipping initialization`);
                    }
                }
            )
            .subscribe((status) => {
                console.log('Realtime subscription status:', status);
            });
    }

    async cleanup() {
        console.log('Cleaning up BotManagerService...');
        await this.stopAllBots();
        
        if (this.realtimeChannel) {
            await supabase.removeChannel(this.realtimeChannel);
            this.realtimeChannel = null;
        }
    }

    async initializeBots() {
        try {
            // Fetch and initialize bots
            const { data: bots, error } = await supabase
                .from('bots')
                .select('id, token_id')
                .not('token_id', 'is', null);

            if (error) {
                throw error;
            }

            console.log(`Found ${bots?.length || 0} bots to initialize`);

            // Initialize each bot with better error tracking
            const results = await Promise.all(
                (bots || []).map(async (bot) => {
                    try {
                        console.log(`Attempting to initialize bot ID: ${bot.id} with token: ${bot.token_id.substring(0, 6)}...`);
                        const success = await this.initializeBot(bot.id, bot.token_id);
                        if (!success) {
                            console.error(`Failed to initialize bot ID: ${bot.id}`);
                        }
                        return { botId: bot.id, success };
                    } catch (error) {
                        console.error(`Error initializing bot ID: ${bot.id}:`, error);
                        return { botId: bot.id, success: false };
                    }
                })
            );

            // Log results
            const successfulBots = results.filter(r => r.success).length;
            const failedBots = results.filter(r => !r.success).length;
            
            console.log(`Initialization complete: ${successfulBots} successful, ${failedBots} failed`);
            
            if (failedBots > 0) {
                console.warn('Some bots failed to initialize. Check the logs above for details.');
            }

            console.log('All bots initialization process completed');
        } catch (error) {
            console.error('Error initializing bots:', error);
            throw error;
        }
    }

    async initializeBot(botId: number, token: string) {
        try {
            const bot = new Telegraf(token);
            this.bots.set(botId, bot);
            
            // Update the activation service with the new bot
            this.activationService = new ActivationService(bot);
            
            // Setup handlers
            setupActivationCommand(bot, this.activationService, this.conversationService);
            setupConversationalHandlers(bot, this.conversationService, this.activationService);
            
            await bot.launch();
            console.log(`Bot ${botId} initialized successfully`);
            return true;
        } catch (error) {
            console.error(`Failed to initialize bot ${botId}:`, error);
            return false;
        }
    }

    async addNewBot(token: string): Promise<number | null> {
        try {
            // Validate token by trying to get bot info
            const tempBot = new Telegraf(token);
            const botInfo = await tempBot.telegram.getMe();
            
            // Insert the new bot into database
            const { data, error } = await supabase
                .from('bots')
                .insert({
                    bot_name: botInfo.username,
                    bot_type: 'custom',
                    token_id: token,
                })
                .select('id')
                .single();

            if (error) throw error;

            // Initialize the bot
            await this.initializeBot(data.id, token);
            
            return data.id;
        } catch (error) {
            console.error('Error adding new bot:', error);
            return null;
        }
    }

    async stopBot(botId: number) {
        const bot = this.bots.get(botId);
        if (bot) {
            try {
                // Stop the bot
                await bot.stop('SIGTERM');
                this.bots.delete(botId);
                console.log(`Bot ${botId} stopped successfully`);
            } catch (error) {
                console.error(`Error stopping bot ${botId}:`, error);
            }
        }
    }

    async stopAllBots() {
        for (const [botId, bot] of this.bots) {
            try {
                await bot.stop('SIGTERM');
                console.log(`Bot ${botId} stopped`);
            } catch (error) {
                console.error(`Error stopping bot ${botId}:`, error);
            }
        }
        this.bots.clear();
    }
} 