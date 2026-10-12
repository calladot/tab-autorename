export type RuleMode = "static" | "template";

export interface RenameRule {
  id: string;
  enabled: boolean;
  pattern: string;
  mode: RuleMode;
  value: string;
  createdAt: number;
  updatedAt: number;
}

export interface ExtensionState {
  globalEnabled: boolean;
  rules: RenameRule[];
}

export const DEFAULT_STATE: ExtensionState = {
  globalEnabled: true,
  rules: []
};
