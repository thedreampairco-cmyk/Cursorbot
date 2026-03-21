export const handleError = (context, error) => {
  console.error(`❌ Error in ${context}:`, error?.response?.data || error.message || error);
};
