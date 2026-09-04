import { ArrayMinSize, ArrayMaxSize, IsArray, IsUUID } from 'class-validator';

export class GenerateDraftsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  directionIds!: string[];
}
