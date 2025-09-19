declare module "bible-passage-reference-parser/js/en_bcv_parser" {
    export class bcv_parser {
        constructor()
        set_options(options: any): void
        parse(input: string): { osis_and_indices(): any[] }
    }
}
