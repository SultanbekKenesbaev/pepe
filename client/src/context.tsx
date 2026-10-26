import { createContext, useContext } from 'react';
import type { User, Institution, AIStatus } from '../../shared/types';
export interface AppContextValue { user:User; institutions:Institution[]; institutionId:string; setInstitutionId:(id:string)=>void; refreshBootstrap:()=>Promise<void>; notify:(message:string,type?:'success'|'error'|'info')=>void; ai:AIStatus }
export const AppContext = createContext<AppContextValue | null>(null);
export function useApp() { const ctx = useContext(AppContext); if (!ctx) throw new Error('AppContext missing'); return ctx; }
