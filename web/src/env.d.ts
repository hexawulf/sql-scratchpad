/// <reference types="vite/client" />

declare const __APP_VERSION__: string;
declare const __GIT_SHA__: string;

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}

declare module 'splitpanes' {
  import type { DefineComponent } from 'vue';
  export const Splitpanes: DefineComponent<
    {
      horizontal?: boolean;
      pushOtherPanes?: boolean;
      dblClickSplitter?: boolean;
      rtl?: boolean;
      firstSplitter?: boolean;
    },
    Record<string, unknown>,
    unknown
  >;
  export const Pane: DefineComponent<
    {
      size?: number | string;
      minSize?: number | string;
      maxSize?: number | string;
    },
    Record<string, unknown>,
    unknown
  >;
}

declare module 'splitpanes/dist/splitpanes.css';
