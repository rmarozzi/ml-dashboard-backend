import prisma from "./prisma";

export async function filterMlAccounts(user: any): Promise<string[]> {
  const liderId = user.role === "funcionario" ? user.liderId : user.id;
  const tokens = await prisma.token.findMany({
    where: { userId: liderId },
    select: { id: true },
  });
  return tokens.map((t) => t.id);
}

export function getLiderId(user: any): string {
  return user.role === "funcionario" ? user.liderId : user.id;
}