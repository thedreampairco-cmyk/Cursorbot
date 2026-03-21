const memory = new Map();

// Get conversation history
export const getUserMemory = (chatId) => {
  return memory.get(chatId) || [];
};

// Save new message
export const saveUserMessage = (chatId, role, content) => {
  const existing = memory.get(chatId) || [];

  const updated = [
    ...existing,
    { role, content }
  ];

  // Keep only last 10 messages (avoid token overflow)
  memory.set(chatId, updated.slice(-10));
};
