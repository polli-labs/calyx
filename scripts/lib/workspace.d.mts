/**
 * Calyx's own manifest block. Both members exist so that a package's
 * exceptional treatment is declared by the package itself rather than listed in
 * the surface that would otherwise have to remember it.
 */
export interface CalyxPackageMetadata {
  /** How this package reaches npm. Read by `scripts/release-plan.mjs`. */
  readonly release?: {
    /** `tagged`: an entry point the tag release publishes with its runtime closure.
     *  `gated`: withheld from the tag release and published by `workflow`. */
    readonly channel?: string;
    readonly workflow?: string;
    readonly reason?: string;
  };
  /** How the test suite resolves this package. Read by `vitest.config.ts`. */
  readonly testResolution?: {
    /** `artifact`: consume the built `dist/` rather than a source alias. */
    readonly mode?: string;
    readonly reason?: string;
  };
}

export interface WorkspacePackageManifest {
  readonly name: string;
  readonly version?: string;
  readonly private?: boolean;
  readonly scripts?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly calyx?: CalyxPackageMetadata;
  readonly [field: string]: unknown;
}

export interface WorkspacePackage {
  /** The manifest `name`, i.e. the specifier other packages import. */
  readonly name: string;
  /** Repo-root-relative, POSIX-separated directory, e.g. `packages/core`. */
  readonly relativePath: string;
  /** Absolute directory. */
  readonly directory: string;
  readonly manifest: WorkspacePackageManifest;
}

export function allPackages(repoRoot?: string): readonly WorkspacePackage[];

export function runtimeClosure(entryPackageName: string, repoRoot?: string): readonly WorkspacePackage[];

export function workspaceDependencies(manifest: WorkspacePackageManifest): readonly string[];
