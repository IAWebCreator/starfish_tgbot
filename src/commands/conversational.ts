import { Telegraf, Context } from 'telegraf';
import { ConversationService } from '../services/conversationService';
import { ActivationService } from '../services/activationService';
import { supabase } from '../lib/supabase';

export function setupConversationalHandlers(bot: Telegraf, conversationService: ConversationService, activationService: ActivationService) {
    bot.on('text', async (ctx, next) => {
        // Skip if this is a command
        if (ctx.message.text.startsWith('/')) {
            console.log('Skipping command message');
            return next();
        }

        const groupId = ctx.chat?.id.toString();
        const botId = ctx.botInfo.id.toString();

        // Check if bot is mentioned or replied to
        const isMentioned = ctx.message.text.includes(ctx.botInfo.username) || 
                          (ctx.message.reply_to_message?.from?.id === ctx.botInfo.id);

        // Only process if the bot is mentioned
        if (!isMentioned) {
            return next();
        }

        try {
            // Check if this specific bot is active in this group
            const { data: activeActivation, error } = await supabase
                .from('activations')
                .select('*')
                .eq('telegram_group_id', groupId)
                .eq('selectedbotid', botId)
                .eq('activation_status', 'active')
                .order('created_at', { ascending: false })
                .limit(1)
                .single();

            console.log('Bot activation check:', {
                groupId,
                botId,
                isActive: !!activeActivation,
                error
            });

            // If no active activation found for this bot in this group, skip the message
            if (!activeActivation) {
                console.log(`Bot ${botId} is not active in group ${groupId}, skipping message`);
                return next();
            }

            // Check and handle activation expiration
            const expirationCheck = await conversationService.checkAndHandleExpiration(groupId, botId);
            if (expirationCheck.isExpired) {
                await ctx.reply('This bot has expired and is no longer active in this group.');
                return next();
            }

            // Process the message since the bot is active and not expired
            console.log('Processing message for active bot');
            await conversationService.handleMessage(ctx);

        } catch (error) {
            console.error('Error checking bot activation:', error);
            return next();
        }
    });
} 