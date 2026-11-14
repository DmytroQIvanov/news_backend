import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsISO8601, IsNotEmpty, IsObject, IsOptional, IsString, Matches, MaxLength, ValidateNested } from 'class-validator';
export const CATEGORIES = [
  'model',
  'api',
  'coding',
  'open_source',
  'research',
  'business',
  'defense',
  'cybersecurity',
  'science_space',
  'hardware_gaming',
  'startups_fintech',
  'education_grants',
  'global_tech',
  'other',
] as const;
export type NewsCategory = (typeof CATEGORIES)[number];
export const IMPORTANCE = ['high','medium','low','unknown'] as const;
export const FREE_ACCESS = ['yes','no','unknown'] as const;
export class SourceDto {
  @IsString() @Matches(/^[a-z0-9][a-z0-9-]{2,79}$/) slug!: string;
  @IsString() @MaxLength(160) @IsNotEmpty() name!: string;
  @IsString() @Matches(/^https:\/\//i) @MaxLength(2048) homepageUrl!: string;
  @IsOptional() @IsString() @Matches(/^https:\/\//i) @MaxLength(2048) feedUrl?: string;
  @IsOptional() @IsBoolean() unofficial?: boolean;
}
export class ArticleDto {
  @IsString() @MaxLength(250) @IsNotEmpty() externalId!: string;
  @IsString() @MaxLength(350) @IsNotEmpty() originalTitle!: string;
  @IsOptional() @IsString() @MaxLength(2500) originalSummary?: string;
  @IsString() @Matches(/^https:\/\//i) @MaxLength(2048) url!: string;
  @IsOptional() @IsISO8601() publishedAt?: string;
  @IsOptional() @IsString() @MaxLength(350) titleUk?: string;
  @IsOptional() @IsString() @MaxLength(2500) summaryUk?: string;
  @IsOptional() @IsString() @MaxLength(1500) whyItMatters?: string;
  @IsIn(CATEGORIES) category!: typeof CATEGORIES[number];
  @IsIn(IMPORTANCE) importance!: typeof IMPORTANCE[number];
  @IsIn(FREE_ACCESS) freeAccess!: typeof FREE_ACCESS[number];
  @IsOptional() @IsObject() aiMetadata?: Record<string, unknown>;
}
export class IngestRequestDto {
  @ValidateNested() @Type(() => SourceDto) source!: SourceDto;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(25) @ValidateNested({ each: true }) @Type(() => ArticleDto) items!: ArticleDto[];
}
