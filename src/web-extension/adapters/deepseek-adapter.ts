import { ConfiguredWebChatAdapter } from './adapter-interface'

export function resolveDeepSeekRole(el: Element): 'assistant' | 'user' | 'system' {
  const explicit = (
    el.getAttribute('data-role') ??
    el.getAttribute('data-message-author-role') ??
    ''
  ).toLowerCase()
  if (explicit === 'user' || explicit === 'human') return 'user'
  if (explicit === 'assistant' || explicit === 'model' || explicit === 'ai') return 'assistant'
  if (explicit === 'system') return 'system'

  const classAttr = typeof el.className === 'string' ? el.className.toLowerCase() : ''
  if (classAttr.includes('user') || el.querySelector('[data-role="user"]')) return 'user'
  if (classAttr.includes('assistant') || el.querySelector('.ds-markdown, [data-role="assistant"]')) {
    return 'assistant'
  }
  return 'user'
}

export class DeepSeekWebAdapter extends ConfiguredWebChatAdapter {
  constructor() {
    super({
      site: 'deepseek',
      allowedOrigin: 'https://chat.deepseek.com',
      composerSelectors: [
        'textarea#chat-input',
        'textarea[data-testid="chat-input"]',
        'textarea[placeholder*="DeepSeek" i]',
        'textarea[placeholder]',
        'div[contenteditable="true"][role="textbox"]',
        'div[contenteditable="true"]'
      ],
      sendButtonSelectors: [
        'button[data-testid="send-button"]',
        'button[aria-label*="send" i]',
        'button[aria-label*="enviar" i]',
        'div[role="button"][aria-label*="send" i]',
        'div[role="button"].ds-button--primary._52c986b:not(.ds-button--disabled)',
        'div[role="button"].ds-button--primary:not(.ds-button--disabled)',
        'button.ds-button--primary:not(.ds-button--disabled)',
        'div[role="button"]._7436101',
        'button[type="submit"]'
      ],
      stopButtonSelectors: [
        'button[aria-label*="stop" i]',
        'button[title*="stop" i]',
        'div[role="button"][aria-label*="stop" i]',
        'button[data-testid="stop-button"]',
        '.ds-button--primary .ds-loading',
        '.ds-loading'
      ],
      messageSelectors: ['[data-message-id]', '[data-testid="chat-message"]', '.ds-message'],
      contentSelectors: ['.ds-markdown', '[data-testid="message-content"]'],
      resolveRole: resolveDeepSeekRole
    })
  }
}
