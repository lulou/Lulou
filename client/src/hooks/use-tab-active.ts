import { createContext, useContext } from "react";

export const TabActiveContext = createContext(true);
export function useTabActive() { return useContext(TabActiveContext); }
