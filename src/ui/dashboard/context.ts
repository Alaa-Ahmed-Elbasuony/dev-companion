import type { InvestigationAnchor, NetworkEntry, Settings } from '../../shared/types';
import type { Analysis } from '../lib/analysis';
import type { View } from '../lib/router';
import type { SessionData } from '../lib/session-data';

/** What every dashboard view receives from the shell. */
export interface ViewProps {
  data: SessionData;
  settings: Settings;
  analysis: Analysis | null;
  params: Record<string, string>;
  setParams: (params: Record<string, string>) => void;
  navigate: (view: View, params?: Record<string, string>) => void;
  investigate: (anchor: InvestigationAnchor) => void;
  openEntry: (id: string) => void;
  reload: () => void;
  onCompare: (slot: 'a' | 'b', id: string) => void;
  onReplay: (entry: NetworkEntry) => void;
  version: number;
  setSession: (id: string) => void;
}
