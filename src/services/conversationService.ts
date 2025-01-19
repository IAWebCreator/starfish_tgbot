import { Context } from 'telegraf';
import { ExtraReplyMessage } from 'telegraf/typings/telegram-types';
import { supabase } from '../lib/supabase';
import { Message } from 'telegraf/types';
import axios from 'axios';
import { config } from '../config/config';

const GEMINI_API = {
    baseURL: 'https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent',
    key: process.env.GEMINI_API_KEY,
    model: 'gemini-1.5-flash'
};

export class ConversationService {
    // Initialize active groups on service start
    async initializeActiveGroups() {
        const { data: activeActivations, error } = await supabase
            .from('activations')
            .select('telegram_group_id')
            .eq('activation_status', 'active')
            .not('telegram_group_id', 'is', null);

        if (error) {
            console.error('Error loading active groups:', error);
            return;
        }

        console.log(`Loaded ${activeActivations.length} active groups`);
    }

    async addActiveGroup(groupId: string, activationId: number) {
        try {
            const { data, error } = await supabase
                .from('activations')
                .update({
                    activation_status: 'active',
                    activation_start: new Date().toISOString(),
                    telegram_group_id: groupId
                })
                .eq('id', activationId)
                .select()
                .single();

            if (error) throw error;
            console.log(`Group ${groupId} activated successfully`);
        } catch (error) {
            console.error('Error activating group:', error);
            throw error;
        }
    }

    async removeActiveGroup(groupId: string, reason: 'expired' | 'stopped' = 'stopped') {
        try {
            const { error } = await supabase
                .from('activations')
                .update({
                    activation_status: reason,
                    activation_end: reason === 'expired' ? new Date().toISOString() : undefined,
                    updated_at: new Date().toISOString()
                })
                .eq('telegram_group_id', groupId)
                .eq('activation_status', 'active');

            if (error) throw error;
            console.log(`Group ${groupId} deactivated successfully (${reason})`);
        } catch (error) {
            console.error('Error deactivating group:', error);
            throw error;
        }
    }

    async isGroupActive(groupId: string): Promise<boolean> {
        try {
            console.log('Checking database for active group:', groupId);
            
            const { data, error } = await supabase
                .from('activations')
                .select('id, telegram_group_id, activation_status')
                .eq('telegram_group_id', groupId)
                .eq('activation_status', 'active')
                .single();

            if (error) {
                console.error('Database error checking group status:', error);
                return false;
            }

            console.log('Database response:', data);
            const isActive = !!data;
            console.log(`Group ${groupId} active status:`, isActive);
            return isActive;

        } catch (error) {
            console.error('Error checking group active status:', error);
            return false;
        }
    }

    async checkAndHandleExpiration(groupId: string, botId: string): Promise<{isExpired: boolean, wasActive: boolean}> {
        try {
            // Get active activation for this specific bot with a single query
            const { data: activation, error } = await supabase
                .from('activations')
                .select(`
                    id,
                    activation_end,
                    activation_status,
                    telegram_group_id,
                    selectedbotid
                `)
                .eq('telegram_group_id', groupId)
                .eq('selectedbotid', botId)
                .eq('activation_status', 'active')
                .single();

            if (error || !activation) {
                console.log(`No active activation found for bot ${botId} in group ${groupId}`);
                return { isExpired: true, wasActive: false };
            }

            // Get current UTC time
            const currentUTC = new Date();
            // Parse activation_end ensuring UTC interpretation
            const activationEndUTC = new Date(activation.activation_end + 'Z');

            if (currentUTC > activationEndUTC) {
                // Update only this specific bot's activation
                const { error: updateError } = await supabase
                    .from('activations')
                    .update({
                        activation_status: 'expired',
                        updated_at: currentUTC.toISOString()
                    })
                    .match({
                        id: activation.id,
                        selectedbotid: botId,
                        activation_status: 'active'
                    });

                if (updateError) {
                    console.error('Error updating activation status:', updateError);
                    throw updateError;
                }

                console.log(`Activation ${activation.id} for bot ${botId} marked as expired`);
                return { isExpired: true, wasActive: true };
            }

            return { isExpired: false, wasActive: true };
        } catch (error) {
            console.error('Error in checkAndHandleExpiration:', error);
            return { isExpired: true, wasActive: false };
        }
    }

    private async getPrompts(agentId: number) {
        const { data, error } = await supabase
            .from('prompts')
            .select('system_agent_prompt, user_agent_prompt')
            .eq('agent_id', agentId)
            .single();

        if (error || !data) {
            console.error('Error fetching prompts:', error);
            throw error;
        }

        return data;
    }

    private async getConversationContext(agentId: number) {
        const { data, error } = await supabase
            .from('messages')
            .select('message_from, message_text, message_answered')
            .eq('agent_id', agentId)
            .order('created_at', { ascending: false })
            .limit(5);

        if (error) {
            console.error('Error fetching conversation context:', error);
            return [];
        }

        return data || [];
    }

    private async makeGeminiRequest(prompt: string) {
        try {
            const response = await axios.post(
                `${GEMINI_API.baseURL}?key=${GEMINI_API.key}`,
                {
                    contents: [
                        {
                            role: "user",
                            parts: [{ text: prompt }]
                        }
                    ],
                    generationConfig: {
                        temperature: 0.7,
                        maxOutputTokens: 2000,
                        topK: 1,
                        topP: 0.8
                    }
                }
            );

            return response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        } catch (error) {
            console.error('Error making Gemini API request:', error);
            throw error;
        }
    }

    async handleMessage(ctx: Context) {
        if (!ctx.message || !('text' in ctx.message)) {
            return;
        }

        try {
            const groupId = ctx.chat?.id.toString();
            if (!groupId) return;
            const botId = ctx.botInfo?.id.toString();
            const username = ctx.message.from.username || ctx.message.from.id.toString();
            const userMessage = ctx.message.text;

            // Get the active activation and agent info
            const { data: activation, error } = await supabase
                .from('activations')
                .select(`
                    id,
                    agent_id,
                    telegram_group_id,
                    selectedbotid
                `)
                .eq('telegram_group_id', groupId)
                .eq('selectedbotid', botId)
                .eq('activation_status', 'active')
                .single();

            if (error || !activation) {
                console.error('Error getting activation:', error);
                return;
            }

            // Get prompts and conversation context
            const [prompts, conversationContext] = await Promise.all([
                this.getPrompts(activation.agent_id),
                this.getConversationContext(activation.agent_id)
            ]);

            // Format conversation context
            const contextString = conversationContext
                .map(msg => `${msg.message_from}: ${msg.message_text}\nBot: ${msg.message_answered}`)
                .join('\n');

            // Prepare the prompt with replacements
            const userPrompt = prompts.user_agent_prompt
                .replace('{user_message}', userMessage)
                .replace('{username}', username)
                .replace('{conversation_context}', contextString);

            // Combine prompts and get AI response
            const combinedPrompt = `${prompts.system_agent_prompt}\n\n${userPrompt}`;
            const botResponse = await this.makeGeminiRequest(combinedPrompt);

            // Send the response
            await ctx.reply(botResponse, {
                reply_to_message_id: ctx.message.message_id
            } as ExtraReplyMessage);

            // Log the interaction
            await this.logMessage({
                activationId: activation.id,
                agentId: activation.agent_id,
                messageFrom: username,
                messageText: userMessage,
                messageAnswered: botResponse
            });

        } catch (error) {
            console.error('Error handling message:', error);
            await ctx.reply('I apologize, but I encountered an error while processing your message. Please try again later.');
        }
    }

    private async logMessage({
        activationId,
        agentId,
        messageFrom,
        messageText,
        messageAnswered
    }: {
        activationId: number;
        agentId: number;
        messageFrom: string;
        messageText: string;
        messageAnswered: string;
    }) {
        try {
            const { error } = await supabase.from('messages').insert({
                activation_id: activationId,
                agent_id: agentId,
                message_from: messageFrom,
                message_text: messageText,
                message_answered: messageAnswered
            });

            if (error) {
                console.error('Error logging message:', error);
            }
        } catch (error) {
            console.error('Error logging message:', error);
        }
    }
} 