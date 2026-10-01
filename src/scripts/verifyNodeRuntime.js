import { verifyNodeRuntime } from '../runtime/nodeRuntimeRequirement.js';

if (!verifyNodeRuntime()) process.exitCode = 1;
