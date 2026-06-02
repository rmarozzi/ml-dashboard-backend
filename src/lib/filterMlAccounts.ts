import prisma from "./prisma";

export async function filterMlAccounts(user: any): Promise<number[]> {
  if (user.role === "admin") {
    const tokens = await prisma.token.findMany({ select: { id: true } });
    return tokens.map((t) => t.id);
  }

  if (user.role === "lider") {
    const tokens = await prisma.token.findMany({
      where: { userId: user.id },
      select: { id: true },
    });
    return tokens.map((t) => t.id);
  }

  // funcionario — only allowed token IDs
  const access = await prisma.employeeMlAccess.findMany({
    where: { funcionarioId: user.id },
    select: { tokenId: true },
  });
  return access.map((a) => a.tokenId);
}

export async function getLiderId(user: any): Promise<number> {
  if (user.role === "lider") return user.id;
  if (user.role === "funcionario") return user.liderId!;
  return user.id;
}
