export interface ActiveProject {
  id: string
  path: string
  name: string
}

export interface ActiveProjectState {
  revision: number
  project: ActiveProject | null
}
