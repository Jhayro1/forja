#!/usr/bin/env node
/**
 * Entry point of Forja Ligera (ligera/PLAN.md): the same CLI, in the «ligera» edition —
 * one agent per block, the user's own Claude/Codex CLIs, no sandbox of Forja's own.
 * The @jhayro1/forja-ligera package points its `forja` binary here.
 */
process.env.FORJA_EDICION = 'ligera';
await import('./bin.js');
