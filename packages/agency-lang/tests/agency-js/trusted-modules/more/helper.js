// Host TypeScript, as far as the sandbox is concerned: a trusted tool may
// import it, and sandboxed code may not.
export const shout = (text) => `${text.toUpperCase()}!`;
