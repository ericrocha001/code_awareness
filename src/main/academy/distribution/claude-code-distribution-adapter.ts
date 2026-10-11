import { SkillBridgeDistributionAdapter } from './skill-bridge-distribution-adapter'

export class ClaudeCodeDistributionAdapter extends SkillBridgeDistributionAdapter {
  constructor() { super('CLAUDE_CODE', '.claude', 'Claude Code') }
}
