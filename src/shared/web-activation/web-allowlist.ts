export const ALLOWED_WEB_MCP_METHODS = new Set<string>([
  'initialize',
  'server/discover',
  'skills/list',
  'skills/get',
  'resources/list',
  'resources/read',
  'tools/list',
  'tools/call'
])

export const ALLOWED_WEB_MCP_TOOLS = new Set<string>([
  'discover_repository',
  'get_relationships',
  'inspect_files',
  'get_references',
  'get_symbol_dependencies',
  'get_symbol_hierarchy',
  'inspect_worktree_structure',
  'read_code',
  'list_academy_skills',
  'get_academy_skill',
  'get_academy_skill_history',
  'get_academy_skill_delivery_status',
  'list_academy_conflicts',
  'get_academy_git_status',
  'verify_academy_change_impact',
  'analyze_academy_change_impact',
  'get_openai_plugin_publication',
  'get_openai_plugin_release',
  'list_artifacts',
  'get_artifact',
  'inspect_artifact_structure',
  'read_artifact_section'
])
