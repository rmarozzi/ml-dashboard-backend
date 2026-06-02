import jwt from "jsonwebtoken";

const SECRET = process.env.JWT_SECRET || "change_me_in_production";

export function signToken(payload: object, expiresIn = "7d"): string {
  return jwt.sign(payload, SECRET, { expiresIn } as any);
}

export function verifyToken(token: string): any {
  return jwt.verify(token, SECRET);
}
