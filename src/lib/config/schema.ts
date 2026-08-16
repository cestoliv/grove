import { z } from 'zod';
import {
  DURATION_HINT,
  isDuration,
  isSize,
  parseDuration,
  parseSize,
  SIZE_HINT,
} from './units.js';

export const durationSchema = z
  .string()
  .refine(isDuration, { message: DURATION_HINT })
  .transform(parseDuration);

export const sizeSchema = z
  .string()
  .refine(isSize, { message: SIZE_HINT })
  .transform(parseSize);

export const DEFAULT_TICK = { fast: 120_000, full: 1_800_000 };

export const tickSchema = z.strictObject({
  fast: durationSchema.optional(),
  full: durationSchema.optional(),
});

const localHostSchema = z.strictObject({
  type: z.literal('local'),
  work_root: z.string().min(1).optional(),
  cache_root: z.string().min(1).optional(),
});

const sshHostSchema = z.strictObject({
  type: z.literal('ssh'),
  host: z
    .string()
    .min(1)
    .refine((value) => !value.startsWith('-'), {
      message: 'host must not start with "-"',
    }),
  work_root: z.string().min(1).optional(),
  cache_root: z.string().min(1).optional(),
});

export const hostSchema = z.discriminatedUnion(
  'type',
  [localHostSchema, sshHostSchema],
  { error: 'type must be "local" or "ssh"' },
);

const tokenAuthSchema = z
  .strictObject({ token: z.string().min(1) })
  .transform((value) => ({ source: 'token' as const, token: value.token }));

const commandAuthSchema = z
  .strictObject({ command: z.string().min(1) })
  .transform((value) => ({
    source: 'command' as const,
    command: value.command,
  }));

export const forgeAuthSchema = z.union([tokenAuthSchema, commandAuthSchema], {
  error:
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder text for the user, not interpolation
    'auth must be { token: "${ENV_VAR}" } or { command: "..." }, or absent to delegate to the gh or glab CLI',
});

const githubForgeSchema = z.strictObject({
  kind: z.literal('github'),
  url: z.url().optional(),
  auth: forgeAuthSchema.optional(),
});

const gitlabForgeSchema = z.strictObject({
  kind: z.literal('gitlab'),
  url: z.url(),
  auth: forgeAuthSchema.optional(),
});

export const forgeSchema = z.discriminatedUnion(
  'kind',
  [githubForgeSchema, gitlabForgeSchema],
  { error: 'kind must be "github" or "gitlab"' },
);

export type HostConfig = z.infer<typeof hostSchema>;
export type ForgeConfig = z.infer<typeof forgeSchema>;
export type ForgeAuth = z.infer<typeof forgeAuthSchema>;
export type ForgeKind = ForgeConfig['kind'];
export type TickConfig = { fast: number; full: number };

export const GROUP_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
export const GROUP_NAME_MAX_LENGTH = 40;

export const GITHUB_LEVELS = [
  'enterprise',
  'organization',
  'repository',
] as const;
export const GITLAB_LEVELS = ['instance', 'group', 'project'] as const;

export const scopeSchema = z.discriminatedUnion(
  'level',
  [
    z.strictObject({
      level: z.literal('enterprise'),
      target: z.string().min(1),
    }),
    z.strictObject({
      level: z.literal('organization'),
      target: z.string().min(1),
    }),
    z.strictObject({
      level: z.literal('repository'),
      target: z.string().min(1),
    }),
    z.strictObject({ level: z.literal('instance') }),
    z.strictObject({ level: z.literal('group'), target: z.string().min(1) }),
    z.strictObject({ level: z.literal('project'), target: z.string().min(1) }),
  ],
  {
    error: `level must be one of ${[...GITHUB_LEVELS, ...GITLAB_LEVELS].join(', ')}`,
  },
);

const countSchema = z.number().int().positive();

export const placementSchema = z
  .union(
    [
      z.strictObject({ host: z.string().min(1), count: countSchema }),
      z.record(z.string().min(1), countSchema),
    ],
    {
      error:
        'placement must be { host: <name>, count: <n> } or { <host>: <n>, ... }',
    },
  )
  .transform((value): Record<string, number> => {
    if (typeof value.host === 'string') {
      return { [value.host]: value.count };
    }
    return value as Record<string, number>;
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'placement must name at least one host',
  });

export const groupSchema = z.strictObject({
  name: z
    .string()
    .max(
      GROUP_NAME_MAX_LENGTH,
      `name must be at most ${GROUP_NAME_MAX_LENGTH} characters, so every derived container, unit and runner name stays legal`,
    )
    .regex(
      GROUP_NAME_PATTERN,
      'name must match ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$',
    ),
  forge: z.string().min(1),
  scope: scopeSchema,
  placement: placementSchema,
  stack: z.enum(['docker', 'native']).default('docker'),
  arch: z.enum(['amd64', 'arm64']).optional(),
  labels: z.array(z.string().min(1)).optional(),
  tags: z.array(z.string().min(1)).optional(),
  image: z.string().min(1).optional(),
  build: z.string().min(1).optional(),
  privileged: z.boolean().optional(),
  volumes: z.array(z.string().min(1)).optional(),
  pull_policy: z.enum(['always', 'missing', 'never']).optional(),
  concurrent: countSchema.optional(),
  limit: countSchema.optional(),
  drain_timeout: durationSchema.optional(),
  max_job_duration: durationSchema.optional(),
  work_root: z.string().min(1).optional(),
  cache_root: z.string().min(1).optional(),
  max_work_size: sizeSchema.optional(),
  raw: z.record(z.string(), z.unknown()).optional(),
});

export const configSchema = z.strictObject({
  tick: tickSchema.optional(),
  hosts: z.record(z.string().min(1), hostSchema),
  forges: z.record(z.string().min(1), forgeSchema),
  groups: z.array(groupSchema).min(1, 'declare at least one group'),
});

export type Scope = z.infer<typeof scopeSchema>;
export type Level = Scope['level'];
export type Placement = Record<string, number>;
export type GroupConfig = z.infer<typeof groupSchema>;
export type ParsedConfig = z.infer<typeof configSchema>;
export type GroveConfig = Omit<ParsedConfig, 'tick'> & { tick: TickConfig };
