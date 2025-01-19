import { Telegraf, Context } from 'telegraf';
import { ActivationService } from '../services/activationService';
import { ConversationService } from '../services/conversationService';
import { supabase } from '../lib/supabase';
import { Markup } from 'telegraf';
import { PromptGeneratorService } from '../services/promptGeneratorService';

interface BotInfo {
    id: number;
    bot_name: string;
}

interface Bot {
    id: number;
    name: string;
    username: string;
}

interface ActivationAttempt {
    userId: number;
    chatId: number;
    timestamp: number;
}

interface ActivationState {
    inProgress: boolean;
    lastAttempt: number;
    attempts: number;
    isActive: boolean;
}

interface BotSelection {
    activationId: number;
    availableBots: Bot[];
    messageId?: number;
}

// Rate limiting constants
const RATE_LIMIT = {
    MAX_ATTEMPTS: 5,
    WINDOW_MS: 60000, // 1 minute
    COOLDOWN_MS: 300000 // 5 minutes
};

export function setupActivationCommand(
    bot: Telegraf, 
    activationService: ActivationService,
    conversationService: ConversationService
) {
    // Add bot start timestamp
    const botStartTime = Date.now();
    
    // Track activation state per group PER BOT
    const activationStates = new Map<string, ActivationState>();
    
    // Store temporary user selections and message IDs PER BOT
    const userBotSelections = new Map<number, number>();
    const activationMessages = new Map<number, number[]>();
    const pendingActivations = new Map<number, ActivationAttempt>();
    const pendingBotSelections = new Map<number, BotSelection>();

    // Cleanup function for pending activations
    const cleanupPendingActivation = (chatId: number) => {
        pendingActivations.delete(chatId);
        const messageIds = activationMessages.get(chatId) || [];
        activationMessages.delete(chatId);
        return messageIds;
    };

    // Helper function to get/create activation state
    const getActivationState = async (groupId: string): Promise<ActivationState> => {
        const stateKey = `${bot.botInfo?.id}_${groupId}`;
        
        // Check if this bot is already active in this group
        const { data: activeActivation, error } = await supabase
            .from('activations')
            .select('*')
            .eq('telegram_group_id', groupId)
            .eq('activation_status', 'active')
            .eq('selectedbotid', bot.botInfo?.id.toString())
            .order('created_at', { ascending: false })
            .limit(1)
            .single();

        if (!activationStates.has(stateKey)) {
            activationStates.set(stateKey, {
                inProgress: false,
                lastAttempt: 0,
                attempts: 0,
                isActive: !!activeActivation
            });
        }

        // Update active status
        const state = activationStates.get(stateKey)!;
        state.isActive = !!activeActivation;

        // Add debug logging
        console.log('Activation state check:', {
            groupId,
            botId: bot.botInfo?.id,
            activeActivation,
            error,
            isActive: state.isActive
        });

        return state;
    };

    // Helper function to cleanup activation state
    const cleanupActivation = (groupId: string) => {
        const stateKey = `${bot.botInfo?.id}_${groupId}`;
        const state = activationStates.get(stateKey);
        if (state) {
            state.inProgress = false;
            // Reset attempts after cooldown
            if (Date.now() - state.lastAttempt > RATE_LIMIT.COOLDOWN_MS) {
                state.attempts = 0;
            }
        }
        // Convert groupId string to number for cleanupPendingActivation
        cleanupPendingActivation(parseInt(groupId));
    };

    // Command to start activation
    bot.command('activation', async (ctx) => {
        try {
            // Check if this is an old message
            const messageTime = ctx.message.date * 1000; // Convert to milliseconds
            if (messageTime < botStartTime) {
                console.log('Ignoring old activation command');
                return;
            }

            if (ctx.chat?.type === 'private') {
                await ctx.reply('This command can only be used in groups.');
                return;
            }

            const groupId = ctx.chat.id.toString();
            const state = await getActivationState(groupId);

            // Enhance the active status check with more specific message
            if (state.isActive) {
                await ctx.reply(
                    `${ctx.botInfo.first_name} is already activated in ${ctx.chat.title || 'this group'}.`
                );
                return;
            }

            // Check if activation is in progress for this specific bot
            if (state.inProgress) {
                await ctx.reply('An activation process is already in progress for this bot. Please wait or start over with /activation.');
                return;
            }

            // Check rate limiting for this specific bot
            if (Date.now() - state.lastAttempt < RATE_LIMIT.WINDOW_MS) {
                state.attempts++;
                if (state.attempts > RATE_LIMIT.MAX_ATTEMPTS) {
                    await ctx.reply(`Too many activation attempts for this bot. Please wait ${RATE_LIMIT.COOLDOWN_MS / 60000} minutes before trying again.`);
                    return;
                }
            } else {
                state.attempts = 1;
            }
            state.lastAttempt = Date.now();

            // Check admin status
            try {
                const [userMember, botMember] = await Promise.all([
                    ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id),
                    ctx.telegram.getChatMember(ctx.chat.id, ctx.botInfo.id)
                ]);

                if (!['administrator', 'creator'].includes(userMember.status)) {
                    await ctx.reply('You need to have admin role in the group to activate the agent.');
                    cleanupActivation(groupId);
                    return;
                }

                if (!['administrator', 'creator'].includes(botMember.status)) {
                    await ctx.reply('You need to promote me as an admin to activate me.');
                    cleanupActivation(groupId);
                    return;
                }
            } catch (error) {
                console.error('Error checking member status:', error);
                await ctx.reply('Failed to verify admin permissions. Please try again.');
                cleanupActivation(groupId);
                return;
            }

            // Create a single button for this bot
            const keyboard = {
                inline_keyboard: [[
                    {
                        text: `Activate ${ctx.botInfo.first_name}`,
                        callback_data: `select_bot:${ctx.botInfo.id}`
                    }
                ]]
            };

            // Store the message ID for later cleanup
            const message = await ctx.reply(
                `Would you like to activate ${ctx.botInfo.first_name}?`,
                { reply_markup: keyboard }
            );

            // Store the message ID in our tracking map
            const chatId = ctx.chat.id;
            if (!activationMessages.has(chatId)) {
                activationMessages.set(chatId, []);
            }
            activationMessages.get(chatId)?.push(message.message_id);

            // Clean up old messages after 1 minute
            setTimeout(() => {
                const messageIds = activationMessages.get(chatId) || [];
                if (messageIds.includes(message.message_id)) {
                    ctx.telegram.deleteMessage(chatId, message.message_id).catch(() => {
                        // Ignore errors from already deleted messages
                    });
                    activationMessages.set(
                        chatId,
                        messageIds.filter(id => id !== message.message_id)
                    );
                }
            }, 60000); // 1 minute timeout

        } catch (error) {
            console.error('Error in activation command:', error);
            await ctx.reply('An error occurred while processing the activation.');
        }
    });

    // Handle bot selection
    bot.action(/select_bot:(\d+)/, async (ctx) => {
        // Check if this is an old callback
        const callbackTime = ctx.callbackQuery.message?.date 
            ? ctx.callbackQuery.message.date * 1000 
            : Date.now();
            
        if (callbackTime < botStartTime) {
            console.log('Ignoring old callback');
            await ctx.answerCbQuery('This activation request has expired. Please start a new activation.');
            return;
        }

        const match = ctx.match[1];
        const botId = parseInt(match);
        const userId = ctx.from?.id;
        const chatId = ctx.chat?.id;

        if (!userId || !chatId) {
            await ctx.reply('Could not identify user or chat.');
            return;
        }

        const groupId = chatId.toString();
        const state = await getActivationState(groupId);

        // If this bot is already active in this group, inform the user
        if (state.isActive) {
            await ctx.answerCbQuery('This bot is already active in this group.');
            return;
        }

        // Verify this is the correct bot handling the callback
        if (botId !== ctx.botInfo.id) {
            return; // Silently ignore if it's not for this bot
        }

        try {
            // Set the activation as in progress
            state.inProgress = true;

            // Store the activation attempt
            pendingActivations.set(chatId, {
                userId: userId,
                chatId: chatId,
                timestamp: Date.now()
            });

            // Clean up other activation messages in this chat
            const messageIds = activationMessages.get(chatId) || [];
            for (const messageId of messageIds) {
                try {
                    await ctx.telegram.deleteMessage(chatId, messageId);
                } catch (error) {
                    // Ignore errors from already deleted messages
                }
            }
            activationMessages.delete(chatId);

            // Send the new message about verification code
            const newMessage = await ctx.reply(
                `${ctx.botInfo.first_name} selected! Please enter the verification code to activate me in this group.`
            );

            // Store this new message for potential cleanup
            activationMessages.set(chatId, [newMessage.message_id]);

            // Set timeout to cleanup after 5 minutes
            setTimeout(async () => {
                const pendingActivation = pendingActivations.get(chatId);
                if (pendingActivation) {
                    cleanupActivation(groupId);
                    try {
                        await ctx.reply('Activation request has expired. Please start over with /activation if needed.');
                    } catch (error) {
                        console.error('Error sending expiration message:', error);
                    }
                }
            }, 5 * 60 * 1000); // 5 minutes

            await ctx.answerCbQuery(); // Acknowledge the button press

        } catch (error) {
            console.error('Error in bot selection:', error);
            state.inProgress = false;
            await ctx.answerCbQuery('An error occurred. Please try again.');
            cleanupActivation(groupId);
        }
    });

    // Handle verification code messages
    bot.on('text', async (ctx, next) => {
        // Check if this is an old message
        const messageTime = ctx.message.date * 1000;
        if (messageTime < botStartTime) {
            console.log('Ignoring old message');
            return next();
        }

        const message = ctx.message.text;
        const chat = ctx.chat;
        const from = ctx.from;

        if (!chat || !from || chat.type === 'private') {
            return next();
        }

        const groupId = chat.id.toString();
        const state = await getActivationState(groupId);

        // Check if this chat has a pending activation and is in progress
        if (!state.inProgress || !pendingActivations.get(chat.id)) {
            return next();
        }

        // Check if the user sending the code is the same who initiated the activation
        const pendingActivation = pendingActivations.get(chat.id);
        if (!pendingActivation || from.id !== pendingActivation.userId) {
            return next();
        }

        console.log('=== Verification Code Check ===');
        console.log(`Received code: ${message}`);
        console.log(`Chat ID: ${chat.id}`);
        console.log(`User ID: ${from.id}`);

        try {
            // Check if this is a verification code attempt
            const { data: activation, error } = await supabase
                .from('activations')
                .select(`
                    id,
                    verification_code,
                    selectedbotid,
                    verification_used_at,
                    activation_status,
                    duration_hours,
                    telegram_authorized_user
                `)
                .eq('verification_code', message.trim())
                .single();

            if (error || !activation) {
                console.log('Invalid verification code attempt:', message);
                await ctx.reply('Invalid code. Please start the process again with /activation.');
                cleanupActivation(groupId);
                return;
            }

            // Check if code has already been used
            if (activation.verification_used_at || activation.activation_status !== 'pending') {
                console.log('Attempted to use already verified code');
                await ctx.reply('This verification code has already been used. Please use /activation to start a new activation process.');
                cleanupActivation(groupId);
                return;
            }

            // Check if the user is authorized
            const userUsername = ctx.from.username 
                ? `@${ctx.from.username}` 
                : null;

            if (!userUsername || userUsername.toLowerCase() !== activation.telegram_authorized_user.toLowerCase()) {
                console.log('Unauthorized user attempted to use verification code', {
                    attemptedUser: userUsername,
                    authorizedUser: activation.telegram_authorized_user
                });
                await ctx.reply(`Only ${activation.telegram_authorized_user} can use this verification code.`);
                cleanupActivation(groupId);
                return;
            }

            console.log('Found activation:', {
                id: activation.id,
                code: activation.verification_code,
                selectedBotId: activation.selectedbotid,
                status: activation.activation_status
            });

            // Check if this bot matches the selectedBotId
            const currentBotId = ctx.botInfo.id.toString();
            console.log('Comparing bot IDs:', {
                currentBotId,
                selectedBotId: activation.selectedbotid
            });

            if (!activation.selectedbotid || !currentBotId.startsWith(activation.selectedbotid)) {
                console.log('Bot ID mismatch');
                await ctx.reply('The selected bot does not match the verification code. Please make sure you are using the correct bot.');
                cleanupActivation(groupId);
                return;
            }

            try {
                // Proceed with activation since the bot matches
                const groupName = chat.title || 'Unnamed Group';
                const activationStart = new Date();
                const activationEnd = new Date(activationStart);
                
                // Add duration hours to the end date
                if (activation.duration_hours) {
                    activationEnd.setHours(activationEnd.getHours() + activation.duration_hours);
                }

                // First update the activation record with group details
                const { error: updateError } = await supabase
                    .from('activations')
                    .update({
                        telegram_group_name: groupName,
                        activation_start: activationStart.toISOString(),
                        activation_end: activationEnd.toISOString(),
                        verification_used_at: new Date().toISOString(),
                        activation_status: 'active'
                    })
                    .eq('id', activation.id);

                if (updateError) {
                    console.error('Error updating activation details:', updateError);
                    throw updateError;
                }

                // Generate prompts for the agent
                try {
                    const promptGenerator = new PromptGeneratorService();
                    await promptGenerator.generateAndSavePrompts(activation.id, ctx);
                } catch (error) {
                    console.error('Error in prompt generation:', error);
                    // Don't fail the activation if prompt generation fails
                    // The error message will be sent by the service
                }

                // Then proceed with adding the active group
                await conversationService.addActiveGroup(
                    chat.id.toString(),
                    activation.id
                );

                // Clean up the pending activation
                cleanupPendingActivation(chat.id);

                const durationText = activation.duration_hours 
                    ? `for ${activation.duration_hours} hours` 
                    : 'indefinitely';
                
                await ctx.reply(`Verification successful! I am now activated in ${groupName} ${durationText}.`);
            } catch (error) {
                console.error('Error during activation:', error);
                await ctx.reply('There was an error during activation. Please try again or contact support.');
                cleanupActivation(groupId);
            }
        } catch (error) {
            console.error('Error during verification:', error);
            await ctx.reply('An error occurred during verification. Please try again.');
            cleanupActivation(groupId);
        }
    });

    bot.command('activate', async (ctx) => {
        if (ctx.chat?.type === 'private') {
            await ctx.reply('This command can only be used in groups.');
            return;
        }

        // Extract code and username from command
        const args = ctx.message.text.split(' ');
        if (args.length !== 3) {
            await ctx.reply('Usage: /activate <code> <username>');
            return;
        }

        const [_, code, username] = args;

        try {
            const result = await activationService.verifyActivationCode(code, username);
            
            if (!result.isValid || !result.activation) {
                await ctx.reply(result.message || 'Invalid activation code.');
                return;
            }

            // Fetch available bots for this activation
            const availableBots = await activationService.getAvailableBotsForActivation(result.activation.id);
            
            if (!availableBots.length) {
                await ctx.reply('No bots are available for this activation.');
                return;
            }

            // Create inline keyboard with available bots
            const keyboard = Markup.inlineKeyboard(
                availableBots.map(bot => 
                    Markup.button.callback(
                        bot.name, 
                        `select_bot:${result.activation!.id}:${bot.id}`
                    )
                )
            );

            // Store the pending bot selection
            const message = await ctx.reply(
                'Please select which bot you would like to activate:',
                keyboard
            );

            pendingBotSelections.set(ctx.chat.id, {
                activationId: result.activation.id,
                availableBots,
                messageId: message.message_id
            });

        } catch (error) {
            console.error('Error in activate command:', error);
            await ctx.reply('An error occurred while processing your activation.');
        }
    });

    // Handle bot selection
    bot.action(/^select_bot:(\d+):(\d+)$/, async (ctx) => {
        const [activationId, botId] = ctx.match.slice(1).map(Number);
        const chatId = ctx.chat!.id;

        const selection = pendingBotSelections.get(chatId);
        if (!selection || selection.activationId !== activationId) {
            await ctx.answerCbQuery('This selection is no longer valid.');
            return;
        }

        try {
            // Set the selected bot
            const success = await activationService.setSelectedBot(activationId, botId);
            if (!success) {
                await ctx.answerCbQuery('Failed to select bot. Please try again.');
                return;
            }

            // Update activation with group info
            let groupName = 'Unnamed Group';
            const chat = ctx.chat;
            if (chat && (chat.type === 'group' || chat.type === 'supergroup')) {
                groupName = chat.title || groupName;
            }

            const success2 = await activationService.updateActivationWithGroupInfo(
                activationId,
                chatId.toString(),
                groupName
            );

            if (!success2) {
                await ctx.answerCbQuery('Failed to activate bot in this group. Please try again.');
                return;
            }

            await ctx.answerCbQuery('Bot activated successfully!');
            await ctx.reply('Bot has been successfully activated in this group!');

        } catch (error) {
            console.error('Error handling bot selection:', error);
            await ctx.answerCbQuery('An error occurred while selecting the bot.');
        } finally {
            // Clean up the selection state
            pendingBotSelections.delete(chatId);
            
            // Try to delete the selection message
            if (selection.messageId) {
                try {
                    await ctx.telegram.deleteMessage(chatId, selection.messageId);
                } catch (error) {
                    console.error('Error deleting selection message:', error);
                }
            }
        }
    });
} 