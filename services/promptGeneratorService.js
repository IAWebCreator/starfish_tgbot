// Add retry logic with exponential backoff
async makeGeminiRequest(prompt) {
  const maxRetries = 3;
  let delay = 1000; // Start with 1 second delay
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await this.geminiClient.makeRequest(prompt);
    } catch (error) {
      if (error.status === 429 && i < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, delay));
        delay *= 2; // Exponential backoff
        continue;
      }
      throw error;
    }
  }
}

async generateAndSavePrompts(groupId) {
  try {
    // Generate prompts
    const prompts = await this.generatePrompts();
    
    // Validate prompts before saving
    if (!prompts || !Array.isArray(prompts)) {
      throw new Error('Invalid prompts generated');
    }
    
    // Save to database with error handling
    await this.savePrompts(groupId, prompts);
    
    return prompts;
  } catch (error) {
    console.error('Error generating/saving prompts:', error);
    throw error;
  }
} 