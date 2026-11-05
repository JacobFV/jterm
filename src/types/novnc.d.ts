/**
 * The part of noVNC's `RFB` that jterm uses. noVNC ships no types, and typing
 * only what is called keeps this honest: anything not here has not been read.
 */
declare module "@novnc/novnc" {
  export interface RfbCredentials {
    username?: string;
    password?: string;
    target?: string;
  }

  export default class RFB extends EventTarget {
    constructor(
      target: HTMLElement,
      urlOrChannel: string | object,
      options?: { shared?: boolean; credentials?: RfbCredentials },
    );
    viewOnly: boolean;
    scaleViewport: boolean;
    clipViewport: boolean;
    resizeSession: boolean;
    showDotCursor: boolean;
    background: string;
    focusOnClick: boolean;
    disconnect(): void;
    sendCredentials(credentials: RfbCredentials): void;
    sendCtrlAltDel(): void;
    clipboardPasteFrom(text: string): void;
    focus(): void;
    blur(): void;
  }
}
