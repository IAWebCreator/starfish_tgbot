import { supabase } from '../lib/supabase';
import { Activation } from '../types/database';
import { Telegraf } from 'telegraf';
import { PromptGeneratorService } from './promptGeneratorService';

interface AgentWithBot {
    agents: {
        bot_id: number;
    }
}

interface ActivationWithAgent {
    agent_id: number;
    agents: {
        bot_id: number;
    };
}

interface Bot {
    id: number;
    name: string;
    username: string;
}

interface AvailableBot {
    id: number;
    name: string;
    username: string;
}

interface AgentWithBots {
    available_bots: AvailableBot[];
}

interface ActivationWithBots {
    agent_id: number;
    agents: AgentWithBots;
}

export class ActivationService {
    private bot: Telegraf;
    private promptGenerator: PromptGeneratorService;

    constructor(bot: Telegraf) {
        this.bot = bot;
        this.promptGenerator = new PromptGeneratorService();
    }

    async verifyActivationCode(code: string, username: string): Promise<{
        isValid: boolean;
        message?: string;
        activation?: Activation;
    }> {
        const formattedUsername = username.startsWith('@') ? username : `@${username}`;

        const { data: activation, error } = await supabase
            .from('activations')
            .select('*')
            .eq('verification_code', code)
            .single();

        console.log('Verification attempt:', {
            providedUsername: formattedUsername,
            authorizedUser: activation?.telegram_authorized_user,
            code: code,
            found: !!activation,
            status: activation?.activation_status
        });

        if (error || !activation) {
            console.log('Verification failed: Invalid code');
            return { isValid: false, message: 'Invalid code.' };
        }

        // Check if code has already been used
        if (activation.verification_used_at) {
            console.log('Verification failed: Already activated');
            return { isValid: false, message: 'Verification code already activated.' };
        }

        const normalizedProvidedUsername = formattedUsername.trim().toLowerCase();
        const normalizedAuthorizedUsername = activation.telegram_authorized_user?.trim().toLowerCase() || '';

        console.log('Comparing usernames:', {
            normalizedProvided: normalizedProvidedUsername,
            normalizedAuthorized: normalizedAuthorizedUsername,
            match: normalizedProvidedUsername === normalizedAuthorizedUsername
        });

        if (normalizedProvidedUsername !== normalizedAuthorizedUsername) {
            console.log('Verification failed: Username mismatch');
            return { 
                isValid: false, 
                message: `This verification code can only be used by ${activation.telegram_authorized_user}. You are trying to use it with ${formattedUsername}.`
            };
        }

        console.log('Verification successful!');
        return { isValid: true, activation };
    }

    async checkDuplicateBotActivation(
        activationId: number,
        groupId: string
    ): Promise<boolean> {
        // Get the selected bot for the current activation
        const { data: currentActivation, error: activationError } = await supabase
            .from('activations')
            .select('selected_bot_id')
            .eq('id', activationId)
            .single();

        if (activationError || !currentActivation?.selected_bot_id) {
            console.error('Error fetching current activation:', activationError);
            return false;
        }

        // Check for any active activations with the same bot in the same group
        const { data: existingActivations, error: existingError } = await supabase
            .from('activations')
            .select('id, selected_bot_id')
            .eq('telegram_group_id', groupId)
            .eq('activation_status', 'active')
            .neq('id', activationId);

        if (existingError) {
            console.error('Error checking existing activations:', existingError);
            return false;
        }

        // Check if any existing activation has the same bot_id
        const hasDuplicate = existingActivations.some(
            activation => activation.selected_bot_id === currentActivation.selected_bot_id
        );

        return !hasDuplicate;
    }

    async updateActivationWithGroupInfo(
        activationId: number,
        groupId: string,
        groupName: string
    ): Promise<boolean> {
        console.log('Starting activation update process...');

        // Get the bot ID for this activation
        const { data: activation, error: fetchError } = await supabase
            .from('activations')
            .select('selected_bot_id, duration_hours')
            .eq('id', activationId)
            .single();

        if (fetchError || !activation) {
            console.error('Error fetching activation:', fetchError);
            return false;
        }

        // Check if this specific bot is already active in this group
        const { data: existingActivation, error: existingError } = await supabase
            .from('activations')
            .select('id')
            .eq('telegram_group_id', groupId)
            .eq('activation_status', 'active')
            .eq('selected_bot_id', activation.selected_bot_id)
            .single();

        if (existingActivation) {
            console.log('Bot is already active in this group');
            return false;
        }

        // Calculate timestamps and update activation
        const activationStart = new Date();
        const activationEnd = new Date(activationStart.getTime() + (activation.duration_hours * 60 * 60 * 1000));

        const { error } = await supabase
            .from('activations')
            .update({
                telegram_group_id: groupId,
                telegram_group_name: groupName,
                activation_start: activationStart.toISOString(),
                activation_end: activationEnd.toISOString(),
                activation_status: 'active',
                verification_used_at: activationStart.toISOString(),
                updated_at: activationStart.toISOString()
            })
            .eq('id', activationId);

        if (error) {
            console.error('Error updating activation:', error);
            return false;
        }

        // Generate prompts after successful activation
        try {
            console.log('Starting prompt generation for activation:', activationId);
            await this.promptGenerator.generateAndSavePrompts(activationId);
            console.log('Successfully generated and saved prompts for activation:', activationId);
        } catch (promptError) {
            console.error('Error generating prompts:', promptError);
            // Don't fail the activation if prompt generation fails
            // But we should log it for monitoring
        }

        return true;
    }

    async checkBotTokenValidity(activationId: number, botId: number): Promise<boolean> {
        try {
            const { data, error } = await supabase
                .from('activations')
                .select(`
                    agent_id,
                    agents (
                        bot_id
                    )
                `)
                .eq('id', activationId)
                .single<ActivationWithAgent>();

            if (error || !data) {
                console.error('Error checking bot token validity:', error);
                return false;
            }

            return data.agents.bot_id === botId;
        } catch (error) {
            console.error('Error checking bot token validity:', error);
            return false;
        }
    }

    async getAvailableBotsForActivation(activationId: number): Promise<Bot[]> {
        // Get the agent's available bots
        const { data: activation, error } = await supabase
            .from('activations')
            .select(`
                agent_id,
                agents!inner (
                    available_bots!inner (
                        id,
                        name,
                        username
                    )
                )
            `)
            .eq('id', activationId)
            .single<ActivationWithBots>();

        if (error || !activation) {
            console.error('Error fetching available bots:', error);
            return [];
        }

        // Properly access the nested data structure
        return activation.agents?.available_bots || [];
    }

    async setSelectedBot(activationId: number, botId: number): Promise<boolean> {
        const { error } = await supabase
            .from('activations')
            .update({ selected_bot_id: botId })
            .eq('id', activationId);

        if (error) {
            console.error('Error setting selected bot:', error);
            return false;
        }

        return true;
    }

    async isBotActiveInGroup(botId: number, groupId: string): Promise<boolean> {
        const { data: activation, error } = await supabase
            .from('activations')
            .select('id')
            .eq('telegram_group_id', groupId)
            .eq('selected_bot_id', botId)
            .eq('activation_status', 'active')
            // Check if the activation hasn't expired
            .gt('activation_end', new Date().toISOString())
            .single();

        if (error || !activation) {
            console.log(`Bot ${botId} is not active in group ${groupId}`);
            return false;
        }

        return true;
    }

    async getActivationStatus(groupId: string): Promise<{
        status: 'active' | 'pending' | 'expired' | null;
        activation: any | null;
        error?: any;
    }> {
        try {
            const { data: activation, error } = await supabase
                .from('activations')
                .select('*')
                .eq('telegram_group_id', groupId)
                .order('created_at', { ascending: false })
                .single();

            if (error) {
                console.error('Error fetching activation status:', error);
                return { status: null, activation: null, error };
            }

            if (!activation) {
                return { status: null, activation: null };
            }

            // Check if activation has expired
            if (activation.activation_end && new Date(activation.activation_end) < new Date()) {
                // Update status to expired if needed
                if (activation.activation_status === 'active') {
                    await supabase
                        .from('activations')
                        .update({ activation_status: 'expired' })
                        .eq('id', activation.id);
                    activation.activation_status = 'expired';

                    // Send expiration notification to the group
                    try {
                        await this.bot.telegram.sendMessage(
                            groupId,
                            `🚫 *Bot Activation Expired*\n\n` +
                            `The bot activation in this group has expired. ` +
                            `To continue using the bot, please go to your profile page in agentarium and reactivate it`,
                            { parse_mode: 'Markdown' }
                        );
                    } catch (notifyError) {
                        console.error('Error sending expiration notification:', notifyError);
                    }
                }
            }

            return {
                status: activation.activation_status,
                activation
            };
        } catch (error) {
            console.error('Error in getActivationStatus:', error);
            return { status: null, activation: null, error };
        }
    }

    public async verifyCode(code: string, chatId: string, userId: string): Promise<boolean> {
        try {
            // Get activation data
            const { data: activation, error } = await supabase
                .from('activations')
                .select('*')
                .eq('verification_code', code)
                .single();

            if (error || !activation) {
                console.error('Error finding activation:', error);
                return false;
            }

            // Verify the activation is valid and not already used
            if (activation.verification_used_at || activation.activation_status !== 'pending') {
                console.error('Activation already used or not pending');
                return false;
            }

            // Generate prompts for the agent
            await this.promptGenerator.generateAndSavePrompts(activation.agent_id);

            // Update activation status
            const { error: updateError } = await supabase
                .from('activations')
                .update({
                    verification_used_at: new Date().toISOString(),
                    activation_status: 'active'
                })
                .eq('id', activation.id);

            if (updateError) {
                console.error('Error updating activation:', updateError);
                return false;
            }

            return true;
        } catch (error) {
            console.error('Error in verification process:', error);
            return false;
        }
    }
} 