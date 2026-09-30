import path from 'node:path';

export function resolveVaultPath(
  configuredVaultPath: string | undefined,
  defaultVaultPath: string,
  projectPath: string
): string {
  const candidate = path.resolve(configuredVaultPath?.trim() || defaultVaultPath);
  const project = path.resolve(projectPath);
  const relative = path.relative(project, candidate);

  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('知识库必须与项目目录分离');
  }

  return candidate;
}
