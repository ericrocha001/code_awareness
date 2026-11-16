import { ConfiguredWebChatAdapter } from './adapter-interface'

export function resolveQwenRole(el: Element): 'assistant' | 'user' | 'system' {
  const explicit = (
    el.getAttribute('data-role') ??
    el.getAttribute('data-message-author-role') ??
    el.getAttribute('data-author-role') ??
    ''
  ).toLowerCase()
  if (explicit === 'user' || explicit === 'human') return 'user'
  if (explicit === 'assistant' || explicit === 'model' || explicit === 'ai') return 'assistant'
  if (explicit === 'system') return 'system'

  const classAttr = typeof el.className === 'string' ? el.className.toLowerCase() : ''
  if (classAttr.includes('user') || el.querySelector('[data-role="user"]')) return 'user'
  if (
    classAttr.includes('assistant') ||
    el.querySelector('.qwen-markdown, .markdown-body, [data-role="assistant"]')
  ) {
    return 'assistant'
  }
  return 'user'
}

export class QwenWebAdapter extends ConfiguredWebChatAdapter {
  constructor() {
    super({
      site: 'qwen',
      allowedOrigin: 'https://chat.qwen.ai',
      composerSelectors: [
        'textarea.message-input-textarea',
        'textarea#chat-input',
        'textarea[data-testid="chat-input"]',
        'textarea[placeholder*="Qwen" i]',
        'textarea[placeholder*="Ask" i]',
        'textarea[placeholder*="Send" i]',
        'textarea[placeholder]',
        'div[contenteditable="true"][role="textbox"]',
        'div[contenteditable="true"]'
      ],
      sendButtonSelectors: [
        '.chat-prompt-send-button button.send-button',
        'button.chat-prompt-send-button:not(.stop-button)',
        'button.send-button',
        'button[data-testid="send-button"]',
        'button#send-message-button',
        'button[aria-label*="send" i]',
        'button[aria-label*="enviar" i]',
        'div[role="button"][aria-label*="send" i]',
        'button[type="submit"]'
      ],
      stopButtonSelectors: [
        'button.stop-button',
        '.chat-prompt-send-button .stop-button',
        'button[data-testid="stop-button"]',
        'button[aria-label*="stop" i]',
        'button[aria-label*="pare" i]',
        'button[aria-label*="parar" i]',
        'button[aria-label*="interromper" i]',
        'button[title*="stop" i]',
        'div[role="button"][aria-label*="stop" i]',
        'div[role="button"][aria-label*="pare" i]',
        '.stop-btn'
      ],
      messageSelectors: ['[data-message-id]', '[data-testid="chat-message"]', '.qwen-chat-message', '.chat-message'],
      contentSelectors: ['.qwen-markdown', '.markdown-body', '[data-testid="message-content"]'],
      resolveRole: resolveQwenRole
    })
  }
}
