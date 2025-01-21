import { OpenAI } from 'openai';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { Context } from 'telegraf';

dotenv.config();

const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_KEY!
);

// Initialize OpenAI client with Gemini configuration
const openai = new OpenAI({
    apiKey: process.env.GEMINI_API_KEY,
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/"
});

interface PromptGeneratorData {
    pre_system_prompt: string;
    system_prompt: string;
    user_prompt: string;
}

interface AgentData {
    description: string;
    instructions: string;
    name: string;
}

export class PromptGeneratorService {
    private async getPromptGeneratorData(): Promise<PromptGeneratorData> {
        console.log('Fetching prompt generator data...');
        const { data, error } = await supabase
            .from('prompts_generator')
            .select('pre_system_prompt, system_prompt, user_prompt')
            .eq('id', 1)
            .single();

        if (error || !data) {
            console.error('Error fetching prompt generator data:', error);
            throw error;
        }

        console.log('Successfully fetched prompt generator data');
        return data;
    }

    private async getAgentData(agentId: number): Promise<AgentData> {
        console.log('Fetching agent data for ID:', agentId);
        const { data, error } = await supabase
            .from('agents')
            .select('description, instructions, name')
            .eq('id', agentId)
            .single();

        if (error || !data) {
            console.error('Error fetching agent data:', error);
            throw error;
        }

        console.log('Successfully fetched agent data:', data);
        return data;
    }

    private async makeGeminiRequest(prompt: string) {
        try {
            console.log('Making Gemini 2.0 API request with prompt:', prompt);
            
            const response = await openai.chat.completions.create({
                model: "gemini-1.5-flash",
                messages: [
                    {
                        role: "user",
                        content: prompt
                    }
                ],
                temperature: 0.7,
                max_tokens: 8192,
                top_p: 0.8,
                n: 1
            });

            console.log('Raw API Response:', response);

            if (!response.choices?.[0]?.message?.content) {
                console.error('Invalid API response format:', response);
                throw new Error('Invalid API response format');
            }

            return response.choices[0].message.content;
        } catch (error) {
            console.error('Error in makeGeminiRequest:', error);
            if (error instanceof Error) {
                throw new Error(`Gemini API Error: ${error.message}`);
            }
            throw error;
        }
    }

    private async savePrompts(agentId: number, systemPrompt: string, userPrompt: string) {
        console.log('Saving prompts for agent:', agentId);
        const { error } = await supabase
            .from('prompts')
            .insert({
                agent_id: agentId,
                system_agent_prompt: systemPrompt,
                user_agent_prompt: userPrompt,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            });

        if (error) {
            console.error('Error saving prompts:', error);
            throw error;
        }
        console.log('Successfully saved prompts');
    }

    private async getAgentIdFromActivation(activationId: number): Promise<number> {
        const { data, error } = await supabase
            .from('activations')
            .select('agent_id')
            .eq('id', activationId)
            .single();

        if (error || !data) {
            console.error('Error getting agent_id from activation:', error);
            throw error;
        }

        return data.agent_id;
    }

    public async generateAndSavePrompts(activationId: number, ctx?: Context): Promise<void> {
        try {
            console.log('Starting prompt generation for activation:', activationId);
            
            // 1. Get agent_id from activation
            const agentId = await this.getAgentIdFromActivation(activationId);
            console.log('Found agent_id:', agentId);

            if (ctx) {
                await ctx.reply('🤖 Starting to generate your bot\'s personality...');
            }

            // Get all necessary data
            const [promptGeneratorData, agentData] = await Promise.all([
                this.getPromptGeneratorData(),
                this.getAgentData(agentId)
            ]);

            // 2. Replace placeholders and combine into one text
            const combinedPrompt = promptGeneratorData.pre_system_prompt
                .replace('{{description}}', agentData.description)
                .replace('{{instructions}}', agentData.instructions)
                + `\nName: ${agentData.name}`;

            console.log('Making first API call with combined prompt');
            const firstResponse = await this.makeGeminiRequest(combinedPrompt);
            console.log('First API response received');

            // 3. Combine first response with system_prompt
            const secondPrompt = `${firstResponse}\n\n${promptGeneratorData.system_prompt}`;
            console.log('Making second API call');
            const secondResponse = await this.makeGeminiRequest(secondPrompt);
            console.log('Second API response received');

            // 4. Make final API call with user_prompt
            const finalPrompt = `${secondResponse}\n\n${promptGeneratorData.user_prompt}`;
            console.log('Making final API call');
            const finalResponse = await this.makeGeminiRequest(finalPrompt);
            console.log('Final API response received');

            // 5. Store both responses in prompts table
            await this.savePrompts(agentId, secondResponse, finalResponse);

            // After successful completion
            if (ctx) {
                await ctx.reply(`✨ Your bot is now ready to use! 

🔥 The personality has been generated based on your description.
💬 You can start chatting with your bot right away.
🎯 Try asking questions or starting a conversation!`);
            }

            console.log('Prompt generation completed successfully');
        } catch (error) {
            console.error('Error in generateAndSavePrompts:', error);
            if (ctx) {
                await ctx.reply('❌ There was an error generating your bot\'s personality. Please try again or contact support.');
            }
            throw error;
        }
    }
} 