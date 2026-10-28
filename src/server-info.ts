import metadata from '../package.json' with { type: 'json' };

export const SERVER_INFO = { name: metadata.name, version: metadata.version };
