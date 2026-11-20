import { z } from "zod";

export const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email({ message: "Enter a valid email address." })),
  password: z
    .string()
    .min(8, { message: "Password must be at least 8 characters." })
    .max(72, { message: "Password must be at most 72 characters." }),
});

export type Credentials = z.infer<typeof credentialsSchema>;

export const workspaceNameSchema = z
  .string()
  .trim()
  .min(1, { message: "Workspace name is required." })
  .max(100, { message: "Workspace name must be at most 100 characters." });

export type FormState = {
  error?: string;
  message?: string;
  fieldErrors?: Partial<Record<string, string>>;
  values?: { email?: string };
};

/** Reads credentials from a submitted form and validates them. */
export function parseCredentials(formData: FormData) {
  return credentialsSchema.safeParse({
    email: formData.get("email") ?? "",
    password: formData.get("password") ?? "",
  });
}

/** Flattens zod issues into one message per field. */
export function fieldErrorsFrom(error: z.ZodError): Partial<Record<string, string>> {
  const result: Partial<Record<string, string>> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    result[key] ??= issue.message;
  }
  return result;
}
