export interface StoredSession {
    version: 1;
    source?: 'token' | 'gh';
    token?: string;
}
/** Keep credentials separate for each DSH profile and server. */
export declare function sessionFileFor(serverName: string, url: string, patchPath?: string): string;
/** Serialize state changes and replace the file only after a complete write. */
export declare class SessionStore {
    #private;
    constructor(file: string);
    get file(): string;
    get current(): StoredSession;
    load(): Promise<StoredSession>;
    patch(patch: Partial<StoredSession>, active?: () => boolean): Promise<void>;
    clear(...fields: readonly (keyof StoredSession)[]): Promise<void>;
    clearIf(active: (() => boolean) | undefined, ...fields: readonly (keyof StoredSession)[]): Promise<void>;
    destroy(): Promise<void>;
}
