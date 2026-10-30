import type { Plugin } from 'vite'
import type { ChainConfig, ChainKey } from '../src/config/chains'
import type { ChainContracts } from '../src/config/contracts'

export interface PublicSiteFacts {
  version: string
  chains: Record<ChainKey, ChainConfig>
  contracts: Record<ChainKey, ChainContracts>
  headers?: Record<string, string>
}
export interface PublicFile {
  body: string
  type: string
}
export type PublicFiles = Map<string, PublicFile>
export interface PublicContent {
  language: string
  documentation: string
  openMiner: string
  reviewed: string
  documentedVersion: string
  source: string
  contracts: string
  previewAlt: string
  topics: Record<
    string,
    {
      title: string
      description: string
      sections: Array<{ heading: string; paragraphs?: string[]; items?: string[] }>
    }
  >
}
export const SITE_ORIGIN: string
export const REPOSITORY: string
export const LOCALES: readonly ('en' | 'zh-hant')[]
export const TOPICS: readonly string[]
export const PREVIEW_ROBOTS: string
export const SITE_CONTENT: {
  reviewedOn: string
  reviewedVersion: string
  en: PublicContent
  'zh-hant': PublicContent
}
export function escapeHtml(value: unknown): string
export function safeJson(value: unknown): string
export function docPath(locale: string, topic?: string): string
export function rootMetadata(version: string): string
export function createPublicSite(facts: PublicSiteFacts): PublicFiles
export function publicRoute(
  url: string,
  files: PublicFiles
): { status: number; location?: string; file?: PublicFile }
export function publicSitePlugin(facts: PublicSiteFacts): Plugin
