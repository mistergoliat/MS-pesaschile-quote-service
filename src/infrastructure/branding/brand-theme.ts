export interface BrandTheme {
  readonly id: string;
  readonly version: string;
  readonly company: {
    readonly displayName: string;
    readonly legalName: string;
    readonly website?: string;
  };
  readonly colors: {
    readonly primary: string;
    readonly dark: string;
    readonly light: string;
    readonly secondary?: {
      readonly caribbeanCurrent: string;
      readonly pear: string;
      readonly ashGrey: string;
    };
  };
  readonly typography: {
    readonly title: string;
    readonly subtitle: string;
    readonly body: string;
    readonly fallback: string;
  };
  readonly assets: {
    readonly primaryLogo: string;
    readonly logoLight: string;
    readonly logoDark: string;
    readonly symbol: string;
  };
}

export interface SenderSignatureSocialLinks {
  readonly facebook?: string;
  readonly instagram?: string;
  readonly youtube?: string;
  readonly tiktok?: string;
  readonly linkedin?: string;
}

export interface SenderSignature {
  readonly name: string;
  readonly role: string;
  readonly website?: string;
  readonly email?: string;
  readonly phone?: string;
  readonly address?: string;
  readonly socialLinks?: SenderSignatureSocialLinks;
}
