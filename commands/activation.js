// Add error handling for missing prompts
async function handleMessage(ctx) {
  try {
    const prompts = await fetchPrompts(ctx.groupId);
    if (!prompts || prompts.length === 0) {
      // Generate new prompts if none exist
      await generateAndSavePrompts(ctx.groupId);
      return await handleMessage(ctx); // Retry with new prompts
    }
    // ... rest of message handling
  } catch (error) {
    console.error('Error handling message:', error);
    // Add appropriate error response
  }
} 