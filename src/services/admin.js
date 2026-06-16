function isGroupChat(chat) {
  return chat && (chat.type === 'group' || chat.type === 'supergroup');
}

async function isChatAdmin(api, chatId, userId) {
  const member = await api.getChatMember(chatId, userId);

  return member.status === 'administrator' || member.status === 'creator';
}

export {
  isGroupChat,
  isChatAdmin
};
