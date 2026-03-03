const extension = {
  manifest: {
    name: "calyx-ext-another",
    version: "2.0.0",
    calyx: { apiVersion: "1", domains: ["skills", "tools"] },
  },
  hooks: {
    async activate() {
      return { ok: true, messages: ["another-ext activated"] };
    },
    async beforeCommand(_ctx, domain, command) {
      return { ok: true };
    },
  },
};

export default extension;
