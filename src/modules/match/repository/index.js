import { MemoryMatchRepository } from './memoryRepository.js';
import { PrismaMatchRepository } from './prismaRepository.js';

/**
 * Repository factory. `prisma` is the production default; pass `memory` for
 * tests or an environment without a database.
 *
 * @param {'prisma' | 'memory'} [kind]
 */
export function createRepository(kind = 'prisma') {
  return kind === 'memory' ? new MemoryMatchRepository() : new PrismaMatchRepository();
}

export { MemoryMatchRepository, PrismaMatchRepository };
export default { createRepository, MemoryMatchRepository, PrismaMatchRepository };
