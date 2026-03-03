const extension = {
  manifest: {
    name: "calyx-ext-valid",
    version: "1.0.0",
    calyx: { apiVersion: "1", domains: ["skills"] },
  },
  hooks: {
    async activate(ctx) {
      return { ok: true, messages: ["valid-ext activated"] };
    },
    async beforeCommand(ctx, domain, command) {
      return { ok: true, messages: [`before ${domain} ${command}`] };
    },
    async afterCommand(ctx, domain, command, exitCode) {
      return { ok: true, messages: [`after ${domain} ${command} exit=${exitCode}`] };
    },
    async deactivate(ctx) {
      return { ok: true, messages: ["valid-ext deactivated"] };
    },
  },
};

export default extension;
