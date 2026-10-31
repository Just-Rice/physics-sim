import { parseModel, type ModelDef, type ModelInput } from '../schema';
import { basics, materialsShowcase } from './basics';
import { machines } from './machines';
import { structures } from './structures';
import { softAndFluid } from './soft';
import { space } from './space';
import { fun } from './fun';

const all: ModelInput[] = [...basics, ...materialsShowcase, ...machines, ...structures, ...softAndFluid, ...space, ...fun];

export const BUILTIN_MODELS: ModelDef[] = all.map((m) => parseModel(m));

export const BUILTIN_CATEGORIES = ['Basics', 'Materials', 'Machines', 'Structures', 'Soft & Fluid', 'Space', 'Fun'] as const;
