/* eslint-disable no-underscore-dangle */
import * as path from "path";
import * as vs from "vscode";
import { CancellationToken, CompletionContext, CompletionItem, CompletionItemKind, CompletionItemProvider, CompletionList, CompletionTriggerKind, Disposable, Position, Range, SnippetString, TextDocument } from "vscode";
import * as as from "../../shared/analysis_server_types";
import { IAmDisposable, Logger } from "../../shared/interfaces";
import { disposeAll, flatMap } from "../../shared/utils";
import { fsPath } from "../../shared/utils/fs";
import { resolvedPromise } from "../../shared/utils/promises";
import { cleanDartdoc, createMarkdownString } from "../../shared/vscode/extension_utils";
import { DelayedCompletionItem, LazyCompletionItem } from "../../shared/vscode/interfaces";
import { DasAnalyzerClient } from "../analysis/analyzer_das";
import { hasOverlappingEdits } from "../commands/edit_das";
import { config } from "../config";

// TODO: This code has become messy with the SuggestionSet changes. It could do with some refactoring
// (such as creating a mapping from CompletionSuggestion -> x and SuggestionSet -> x, and then x -> CompletionItem).

export class DartCompletionItemProvider implements CompletionItemProvider, IAmDisposable {
	private disposables: Disposable[] = [];
	private cachedCompletions: { [key: number]: as.AvailableSuggestionSet } = {};
	private existingImports: { [key: string]: { [key: string]: { [key: string]: boolean } } } = {};

	constructor(private readonly logger: Logger, private readonly analyzer: DasAnalyzerClient) {
		this.disposables.push(analyzer.registerForCompletionAvailableSuggestions((n) => this.storeCompletionSuggestions(n)));
		this.disposables.push(analyzer.registerForCompletionExistingImports((n) => this.storeExistingImports(n)));
	}

	public async provideCompletionItems(
		document: TextDocument, position: Position, token: CancellationToken, context: CompletionContext,
	): Promise<CompletionList | undefined> {
		const line = document.lineAt(position.line).text.slice(0, position.character);
		const nextCharacter = document.getText(new Range(position, position.translate({ characterDelta: 200 }))).trim().substr(0, 1);
		const conf = config.for(document.uri);
		const enableCommitCharacters = conf.enableCompletionCommitCharacters;
		const insertArgumentPlaceholders = !enableCommitCharacters && conf.insertArgumentPlaceholders && this.shouldAllowArgPlaceholders(line);

		if (!this.shouldAllowCompletion(line, context))
			return;

		const offset = document.offsetAt(position);
		const resp = await this.analyzer.completionGetSuggestionsResults({
			file: fsPath(document.uri),
			offset,
		});

		if (token && token.isCancellationRequested) {
			return undefined;
		}

		const includedResults = resp.results.map((r) => this.convertResult(document, offset, nextCharacter, enableCommitCharacters, insertArgumentPlaceholders, resp, r));
		const cachedResults = await this.getCachedResults(document, token, nextCharacter, enableCommitCharacters, insertArgumentPlaceholders, document.offsetAt(position), resp);

		await resolvedPromise;
		if (token && token.isCancellationRequested) {
			return undefined;
		}

		const allResults = [...includedResults, ...cachedResults];

		return new CompletionList(allResults);
	}

	private shouldAllowCompletion(line: string, context: CompletionContext): boolean {
		line = line.trim();
		// Filter out auto triggered completions on certain characters based on the previous
		// characters (eg. to allow completion on " if it's part of an import).
		if (context.triggerKind === CompletionTriggerKind.TriggerCharacter) {
			switch (context.triggerCharacter) {
				case "{":
					return line.endsWith("${");
				case "'":
					return line.endsWith("import '") || line.endsWith("export '");
				case "\"":
					return line.endsWith("import \"") || line.endsWith("export \"");
				case "/":
				case "\\":
					return line.startsWith("import \"") || line.startsWith("export \"")
						|| line.startsWith("import '") || line.startsWith("export '");
			}
		}

		// Otherwise, allow through.
		return true;
	}

	private shouldAllowArgPlaceholders(line: string): boolean {
		line = line.trim();

		// Disallow args on imports/exports since they're likely show/hide and
		// we only want the function name. This doesn't catch all cases (for ex.
		// where a show/hide is split across multiple lines) but it's better than
		// nothing. We'd need more semantic info to handle this better, and probably
		// this will go away if commit characters is fixed properly.
		if (line.startsWith("import \"") || line.startsWith("export \"")
			|| line.startsWith("import '") || line.startsWith("export '")) {
			return false;
		}

		return true;
	}

	private storeCompletionSuggestions(notification: as.CompletionAvailableSuggestionsNotification) {
		if (notification.changedLibraries) {
			for (const completionSet of notification.changedLibraries) {
				this.cachedCompletions[completionSet.id] = completionSet;
			}
		}
		if (notification.removedLibraries) {
			for (const completionSetID of notification.removedLibraries) {
				delete this.cachedCompletions[completionSetID];
			}
		}
	}

	private storeExistingImports(notification: as.CompletionExistingImportsNotification) {
		const existingImports = notification.imports;

		// Map with key "elementName/elementDeclaringLibraryUri"
		// Value is a set of imported URIs that import that element.
		const alreadyImportedSymbols: { [key: string]: { [key: string]: boolean } } = {};
		for (const existingImport of existingImports.imports) {
			for (const importedElement of existingImport.elements) {
				// This is the symbol name and declaring library. That is, the
				// library that declares the symbol, not the one that was imported.
				// This wil be the same for an element that is re-exported by other
				// libraries, so we can avoid showing the exact duplicate.
				const elementName = existingImports.elements.strings[existingImports.elements.names[importedElement]];
				const elementDeclaringLibraryUri = existingImports.elements.strings[existingImports.elements.uris[importedElement]];

				const importedUri = existingImports.elements.strings[existingImport.uri];

				const key = `${elementName}/${elementDeclaringLibraryUri}`;
				if (!alreadyImportedSymbols[key])
					alreadyImportedSymbols[key] = {};
				alreadyImportedSymbols[key][importedUri] = true;
			}
		}

		this.existingImports[notification.file] = alreadyImportedSymbols;
	}

	public async resolveCompletionItem(item: DelayedCompletionItem, token: CancellationToken): Promise<CompletionItem | undefined> {
		if (!item.suggestion) {
			if (!item.documentation && item._documentation) {
				item.documentation = item._documentation;
			}
			return item;
		}

		const res = await this.analyzer.completionGetSuggestionDetails({
			file: item.filePath,
			id: item.suggestionSetID,
			label: item.suggestion.label,
			offset: item.offset,
		});

		if (token && token.isCancellationRequested) {
			return;
		}

		// Rebuild the completion using the additional resolved info.
		return this.createCompletionItemFromSuggestion(
			item.document,
			item.offset,
			item.nextCharacter,
			item.enableCommitCharacters,
			item.insertArgumentPlaceholders,
			item.replacementOffset,
			item.replacementLength,
			item.autoImportUri,
			item.relevance,
			item.suggestion,
			res,
		);
	}

	private createCompletionItemFromSuggestion(
		document: TextDocument,
		offset: number,
		nextCharacter: string,
		enableCommitCharacters: boolean,
		insertArgumentPlaceholders: boolean,
		replacementOffset: number,
		replacementLength: number,
		displayUri: string | undefined,
		relevance: number,
		suggestion: as.AvailableSuggestion,
		resolvedResult: as.CompletionGetSuggestionDetailsResponse | undefined,
	) {
		const completionItem = this.makeCompletion(document, offset, nextCharacter, enableCommitCharacters, insertArgumentPlaceholders, {
			autoImportUri: displayUri,
			completionText: (resolvedResult && resolvedResult.completion) || suggestion.label,
			defaultArgumentListString: suggestion.defaultArgumentListString,
			defaultArgumentListTextRanges: suggestion.defaultArgumentListTextRanges,
			displayText: suggestion.label, // Keep the label for display, so we don't update to show "prefix0" as the user moves to it.
			elementKind: suggestion.element ? suggestion.element.kind : undefined,
			isDeprecated: false,
			kind: undefined, // This is only used when there's no element (eg. keyword completions) that won't happen here.
			parameterNames: suggestion.parameterNames,
			parameterType: undefined, // Unimported completions can't be parameters.
			parameters: suggestion.element ? suggestion.element.parameters : undefined,
			relevance,
			replacementLength,
			replacementOffset,
			requiredParameterCount: suggestion.requiredParameterCount,
			returnType: suggestion.element ? suggestion.element.returnType : undefined,
			selectionLength: resolvedResult && resolvedResult.change && resolvedResult.change.selection ? 0 : undefined,
			selectionOffset: resolvedResult && resolvedResult.change && resolvedResult.change.selection ? resolvedResult.change.selection.offset : undefined,
		});

		// Additional edits for the imports.
		if (resolvedResult && resolvedResult.change && resolvedResult.change.edits && resolvedResult.change.edits.length) {
			this.appendAdditionalEdits(completionItem, document, resolvedResult.change);
			if (displayUri)
				completionItem.detail = `Auto import from '${displayUri}'` + (completionItem.detail ? `\n\n${completionItem.detail}` : "");
		}

		// Copy the lazy docs over.
		if (resolvedResult && !completionItem.documentation && completionItem._documentation) {
			completionItem.documentation = completionItem._documentation;
		}

		return completionItem;
	}

	private async getCachedResults(
		document: TextDocument,
		token: CancellationToken,
		nextCharacter: string,
		enableCommitCharacters: boolean,
		insertArgumentPlaceholders: boolean,
		offset: number,
		resp: as.CompletionResultsNotification,
	): Promise<CompletionItem[]> {
		if (!resp.includedSuggestionSets || !resp.includedElementKinds)
			return [];

		const existingImports = resp.libraryFile ? this.existingImports[resp.libraryFile] : undefined;

		// Create a fast lookup for which kinds to include.
		const elementKinds: { [key: string]: boolean } = {};
		resp.includedElementKinds.forEach((k) => elementKinds[k] = true);

		// Create a fast lookup for relevance boosts based on tag string.
		const tagBoosts: { [key: string]: number } = {};
		if (resp.includedSuggestionRelevanceTags)
			resp.includedSuggestionRelevanceTags.forEach((r) => tagBoosts[r.tag] = r.relevanceBoost);

		const filePath = fsPath(document.uri);
		const suggestionSetResults: CompletionItem[][] = [];
		// Keep track of suggestion sets we've seen to avoid included them twice.
		// See https://github.com/dart-lang/sdk/issues/37211.
		const usedSuggestionSets: { [key: number]: boolean } = {};
		// Keep track of items items we've included so we don't show dupes if
		// there are multiple libraries importing the same thing.
		const includedItems: { [key: string]: boolean; } = {};
		for (const includedSuggestionSet of resp.includedSuggestionSets) {
			if (usedSuggestionSets[includedSuggestionSet.id])
				continue;

			// Mark that we've done this one so we don't do it again.
			usedSuggestionSets[includedSuggestionSet.id] = true;

			// Because this work is expensive, we periodically (per suggestion
			// set) yield and check whether cancellation is pending and if so
			// stop and bail out to avoid doing redundant work.
			await resolvedPromise;
			if (token && token.isCancellationRequested) {
				return [];
			}

			const suggestionSet = this.cachedCompletions[includedSuggestionSet.id];
			if (!suggestionSet) {
				this.logger.warn(`Suggestion set ${includedSuggestionSet.id} was not available and therefore not included in the completion results`);
				return [];
			}

			const unresolvedItems = suggestionSet.items
				.filter((r) => elementKinds[r.element.kind])
				.filter((suggestion) => {
					// Check existing imports to ensure we don't already import
					// this element (note: this exact element from its declaring
					// library, not just something with the same name). If we do
					// we'll want to skip it.
					// Trim back to the . to handle enum values
					// https://github.com/Dart-Code/Dart-Code/issues/1835
					const key = `${suggestion.label.split(".")[0]}/${suggestion.declaringLibraryUri}`;
					const importingUris = existingImports && existingImports[key];

					// If there are no URIs already importing this, then include it
					// as an auto-import.
					if (!importingUris)
						return true;

					// Otherwise, it is imported but if it's not by this file, then skip it.
					if (!importingUris[suggestionSet.uri])
						return false;

					// Finally, we're importing a file that has this item, so include
					// it only if it has not already been included by another imported file.

					// Unlike the above, we include the Kind here so that things with similar labels
					// like Constructors+Class are still included.
					const fullItemKey = `${suggestion.label}/${suggestion.element.kind}/${suggestion.declaringLibraryUri}`;
					const itemHasAlreadyBeenIncluded = includedItems[fullItemKey];
					includedItems[fullItemKey] = true;

					return !itemHasAlreadyBeenIncluded;
				})
				.map((suggestion): DelayedCompletionItem => {
					// Calculate the relevance for this item.
					let relevanceBoost = 0;
					if (suggestion.relevanceTags)
						suggestion.relevanceTags.forEach((t) => relevanceBoost = Math.max(relevanceBoost, tagBoosts[t] || 0));

					const completionItem = this.createCompletionItemFromSuggestion(
						document,
						offset,
						nextCharacter,
						enableCommitCharacters,
						insertArgumentPlaceholders,
						resp.replacementOffset,
						resp.replacementLength,
						undefined,
						includedSuggestionSet.relevance + relevanceBoost,
						suggestion,
						undefined,
					);

					// Attach additional info that resolve will need.
					const delayedCompletionItem: DelayedCompletionItem = {
						autoImportUri: includedSuggestionSet.displayUri || suggestionSet.uri,
						document,
						enableCommitCharacters,
						filePath,
						insertArgumentPlaceholders,
						nextCharacter,
						offset,
						relevance: includedSuggestionSet.relevance + relevanceBoost,
						replacementLength: resp.replacementLength,
						replacementOffset: resp.replacementOffset,
						suggestion,
						suggestionSetID: includedSuggestionSet.id,
						...completionItem,
					};

					return delayedCompletionItem;
				});
			suggestionSetResults.push(unresolvedItems);
		}

		return ([] as vs.CompletionItem[]).concat(...suggestionSetResults);
	}

	private convertResult(
		document: TextDocument,
		offset: number,
		nextCharacter: string,
		enableCommitCharacters: boolean,
		insertArgumentPlaceholders: boolean,
		notification: as.CompletionResultsNotification,
		suggestion: as.CompletionSuggestion,
	): CompletionItem {
		return this.makeCompletion(document, offset, nextCharacter, enableCommitCharacters, insertArgumentPlaceholders, {
			completionText: suggestion.completion,
			defaultArgumentListString: suggestion.defaultArgumentListString,
			defaultArgumentListTextRanges: suggestion.defaultArgumentListTextRanges,
			displayText: suggestion.displayText,
			docComplete: suggestion.docComplete,
			elementKind: suggestion.element ? suggestion.element.kind : undefined,
			isDeprecated: suggestion.isDeprecated,
			kind: suggestion.kind,
			parameterNames: suggestion.parameterNames,
			parameterType: suggestion.parameterType,
			parameters: suggestion.element ? suggestion.element.parameters : undefined,
			relevance: suggestion.relevance,
			replacementLength: notification.replacementLength,
			replacementOffset: notification.replacementOffset,
			requiredParameterCount: suggestion.requiredParameterCount,
			returnType: suggestion.returnType || (suggestion.element ? suggestion.element.returnType : undefined),
			selectionLength: suggestion.selectionLength,
			selectionOffset: suggestion.selectionOffset,
		});
	}

	private makeCompletion(
		document: TextDocument, offset: number, nextCharacter: string, enableCommitCharacters: boolean, insertArgumentPlaceholders: boolean, suggestion: {
			autoImportUri?: string,
			completionText: string,
			defaultArgumentListString: string | undefined,
			defaultArgumentListTextRanges: number[] | undefined,
			displayText: string | undefined,
			docComplete?: string | undefined,
			elementKind: as.ElementKind | undefined,
			isDeprecated: boolean,
			kind: as.CompletionSuggestionKind | undefined,
			parameterNames: string[] | undefined,
			parameters: string | undefined,
			parameterType: string | undefined,
			requiredParameterCount: number | undefined,
			relevance: number,
			replacementLength: number,
			replacementOffset: number,
			returnType: string | undefined,
			selectionLength: number | undefined,
			selectionOffset: number | undefined,
		},
	): LazyCompletionItem {
		const completionItemKind = suggestion.elementKind ? this.getElementKind(suggestion.elementKind) : undefined;
		let label = suggestion.displayText || suggestion.completionText;
		let detail: string | undefined;
		const completionText = new SnippetString();
		let triggerCompletion = false;

		const nextCharacterIsOpenParen = nextCharacter === "(";

		// If element has parameters (METHOD/CONSTRUCTOR/FUNCTION), show its parameters.
		if (suggestion.parameters && completionItemKind !== CompletionItemKind.Property && suggestion.kind !== "OVERRIDE"
			// Don't ever show if there is already a paren! (#969).
			&& label.indexOf("(") === -1
		) {
			label += suggestion.parameters.length === 2 ? "()" : "(…)";
			detail = suggestion.parameters;

			const hasParams = (suggestion.parameterNames && suggestion.parameterNames.length > 0)
				|| (insertArgumentPlaceholders && !!suggestion.defaultArgumentListString);

			// Add placeholders for params to the completion.
			if (insertArgumentPlaceholders && hasParams && !nextCharacterIsOpenParen) {
				completionText.appendText(suggestion.completionText);
				completionText.appendText("(");
				if (suggestion.defaultArgumentListString) {
					for (const arg of this.extractTabstopDataForNamedArgs(suggestion.defaultArgumentListString, suggestion.defaultArgumentListTextRanges || [])) {
						const text = suggestion.defaultArgumentListString.substring(arg.start, arg.end);
						if (arg.tabStop)
							completionText.appendPlaceholder(text);
						else
							completionText.appendText(text);
					}
				} else
					completionText.appendTabstop(); // Put a tap stop between parens since there are optional args.
				completionText.appendText(")");
			} else if (insertArgumentPlaceholders && hasParams && !nextCharacterIsOpenParen) {
				completionText.appendText(suggestion.completionText);
				const args = suggestion.parameterNames!.slice(0, suggestion.requiredParameterCount);
				completionText.appendText("(");
				if (args.length) {
					completionText.appendPlaceholder(args[0]);
					for (const arg of args.slice(1)) {
						completionText.appendText(", ");
						completionText.appendPlaceholder(arg);
					}
				} else
					completionText.appendTabstop(0); // Put a tap stop between parens since there are optional args.
				completionText.appendText(")");
			} else if (insertArgumentPlaceholders && !nextCharacterIsOpenParen) {
				completionText.appendText(suggestion.completionText);
				completionText.appendText("()");
			} else {
				completionText.appendText(suggestion.completionText);
			}
		} else if (suggestion.selectionOffset) {
			const before = suggestion.completionText.slice(0, suggestion.selectionOffset);
			const selection = suggestion.completionText.slice(suggestion.selectionOffset, suggestion.selectionOffset + (suggestion.selectionLength || 0));
			// If we have a selection offset (eg. a place to put the cursor) but not any text to pre-select then
			// pop open the completion to help the user type the value.
			// Only do this if it ends with a space (argument completion), see #730.
			if (!selection && suggestion.completionText.slice(suggestion.selectionOffset - 1, suggestion.selectionOffset) === " ")
				triggerCompletion = true;
			const after = suggestion.completionText.slice(suggestion.selectionOffset + (suggestion.selectionLength || 0));

			completionText.appendText(before);
			if (selection)
				completionText.appendPlaceholder(selection);
			else
				completionText.appendTabstop(0);
			completionText.appendText(after);
		} else {
			completionText.appendText(suggestion.completionText);
		}

		// If we're a property, work out the type.
		if (completionItemKind === CompletionItemKind.Property) {
			// Setters appear as methods with one arg (and cause getters to not appear),
			// so treat them both the same and just display with the properties type.
			detail = suggestion.elementKind === "GETTER"
				? suggestion.returnType
				// See https://github.com/dart-lang/sdk/issues/27747
				: suggestion.parameters ? suggestion.parameters.substring(1, suggestion.parameters.lastIndexOf(" ")) : "";
			// Otherwise, get return type from method.
		} else if (suggestion.returnType) {
			detail =
				detail
					? detail + " → " + suggestion.returnType
					: suggestion.returnType;
		} else if (suggestion.parameterType) {
			detail = suggestion.parameterType;
		}

		// If we have trailing commas (flutter) they look weird in the list, so trim the off (for display label only).
		if (label.endsWith(","))
			label = label.substr(0, label.length - 1).trim();

		// If we didnt have a CompletionItemKind from our element, base it on the CompletionSuggestionKind.
		// This covers things like Keywords that don't have elements.
		const kind = completionItemKind || (suggestion.kind ? this.getSuggestionKind(suggestion.kind, label) : undefined);
		const docs = cleanDartdoc(suggestion.docComplete);

		const completion: LazyCompletionItem = new CompletionItem(label, kind);
		completion.filterText = label.split("(")[0]; // Don't ever include anything after a ( in filtering.
		if (suggestion.isDeprecated)
			completion.tags = [vs.CompletionItemTag.Deprecated];
		completion.detail = detail;
		completion._documentation = docs ? createMarkdownString(docs) : undefined;
		completion.insertText = completionText;
		completion.keepWhitespace = true;
		completion.range = {
			inserting: new Range(
				document.positionAt(suggestion.replacementOffset),
				document.positionAt(Math.min(offset, suggestion.replacementOffset + suggestion.replacementLength)),
			),
			replacing: new Range(
				document.positionAt(suggestion.replacementOffset),
				document.positionAt(suggestion.replacementOffset + suggestion.replacementLength),
			),
		};
		if (enableCommitCharacters)
			completion.commitCharacters = this.getCommitCharacters(suggestion.kind);

		const triggerCompletionsFor = ["import '';"];
		if (triggerCompletionsFor.indexOf(label) !== -1)
			triggerCompletion = true;

		// Handle folders in imports better.
		if (suggestion.kind === "IMPORT" && label.endsWith("/"))
			triggerCompletion = true;

		if (triggerCompletion) {
			completion.command = {
				command: "editor.action.triggerSuggest",
				title: "Suggest",
			};
		}

		// Relevance is a number, highest being best. Code sorts by text, so subtract from a large number so that
		// a text sort will result in the correct order.
		// 555 -> 999455
		//  10 -> 999990
		//   1 -> 999999
		completion.sortText = (1000000 - suggestion.relevance).toString();
		return completion;
	}

	/// Argument info comes through as a stringle string like "a: null, b: null"
	/// and an array of ints that are offset/length pairs. [3,4,12,4] means
	/// characters 3-7 and 12 - 16 are tabstops.
	///
	/// To process this more easily, we first convert this into an array like:
	///
	/// ```
	/// [
	///   { start: 0, end: 3, tabStop: false },
	///   { start: 3, end: 7, tabStop: true },
	///   { start: 7, end: 12, tabStop: false },
	///   { start: 12, end: 16, tabStop: true },
	/// ]
	/// ```
	private extractTabstopDataForNamedArgs(argListString: string, argListTextRanges: number[]): Array<{ start: number, end: number, tabStop: boolean }> {
		const ranges: Array<{ start: number, end: number, tabStop: boolean }> = [];
		let currentIndex = 0;

		// For each range, push anything that comes before it, and it.
		for (const range of this.extractOffsetLengthPairs(argListTextRanges)) {
			ranges.push({ start: currentIndex, end: range[0], tabStop: false });
			ranges.push({ start: range[0], end: range[1], tabStop: true });
			currentIndex = range[1];
		}
		// Then push anything left at the end.
		if (currentIndex < argListString.length)
			ranges.push({ start: currentIndex, end: argListString.length, tabStop: false });

		return ranges;
	}

	private extractOffsetLengthPairs(numberPairs: number[]): Array<[number, number]> {
		const pairs: Array<[number, number]> = [];
		for (let i = 0; i < numberPairs.length - 1; i += 2) {
			pairs.push([numberPairs[i], numberPairs[i] + numberPairs[i + 1]]);
		}
		return pairs;
	}

	private getSuggestionKind(kind: as.CompletionSuggestionKind, label: string): CompletionItemKind | undefined {
		switch (kind) {
			case "ARGUMENT_LIST":
				return CompletionItemKind.Variable;
			case "IMPORT":
				return label.startsWith("dart:")
					? CompletionItemKind.Module
					: path.extname(label.toLowerCase()) === ".dart"
						? CompletionItemKind.File
						: CompletionItemKind.Folder;
			case "IDENTIFIER":
				return CompletionItemKind.Variable;
			case "INVOCATION":
				return CompletionItemKind.Method;
			case "KEYWORD":
				return CompletionItemKind.Keyword;
			case "NAMED_ARGUMENT":
				return CompletionItemKind.Variable;
			case "OPTIONAL_ARGUMENT":
				return CompletionItemKind.Variable;
			case "PARAMETER":
				return CompletionItemKind.Value;
		}
		return undefined;
	}

	private getElementKind(kind: as.ElementKind): CompletionItemKind | undefined {
		switch (kind) {
			case "CLASS":
			case "CLASS_TYPE_ALIAS":
				return CompletionItemKind.Class;
			case "COMPILATION_UNIT":
				return CompletionItemKind.Module;
			case "CONSTRUCTOR":
			case "CONSTRUCTOR_INVOCATION":
				return CompletionItemKind.Constructor;
			case "ENUM":
				return CompletionItemKind.Enum;
			case "ENUM_CONSTANT":
				return CompletionItemKind.EnumMember;
			case "FIELD":
				return CompletionItemKind.Field;
			case "FILE":
				return CompletionItemKind.File;
			case "FUNCTION":
			case "FUNCTION_TYPE_ALIAS":
				return CompletionItemKind.Function;
			case "GETTER":
				return CompletionItemKind.Property;
			case "LABEL":
			case "LIBRARY":
				return CompletionItemKind.Module;
			case "LOCAL_VARIABLE":
				return CompletionItemKind.Variable;
			case "METHOD":
				return CompletionItemKind.Method;
			case "PARAMETER":
			case "PREFIX":
				return CompletionItemKind.Variable;
			case "SETTER":
				return CompletionItemKind.Property;
			case "TOP_LEVEL_VARIABLE":
			case "TYPE_PARAMETER":
				return CompletionItemKind.Variable;
			case "UNIT_TEST_GROUP":
				return CompletionItemKind.Module;
			case "UNIT_TEST_TEST":
				return CompletionItemKind.Method;
			case "UNKNOWN":
				return CompletionItemKind.Value;
		}
		return undefined;
	}

	private getCommitCharacters(kind: as.CompletionSuggestionKind | undefined): string[] | undefined {
		switch (kind) {
			case "IDENTIFIER":
			case "INVOCATION":
				return [".", ",", "(", "["];
		}
		return undefined;
	}

	private appendAdditionalEdits(completionItem: vs.CompletionItem, document: vs.TextDocument, change: as.SourceChange | undefined): void {
		if (!change)
			return undefined;

		// VS Code expects offsets to be based on the original document, but the analysis server provides
		// them assuming all previous edits have already been made. This means if the server provides us a
		// set of edits where any edits offset is *equal to or greater than* a previous edit, it will do the wrong thing.
		// If this happens; we will fall back to sequential edits and write a warning.
		const hasProblematicEdits = hasOverlappingEdits(change);

		if (hasProblematicEdits) {
			this.logger.error("Unable to insert imports because of overlapping edits from the server.");
			void vs.window.showErrorMessage(`Unable to insert imports because of overlapping edits from the server`);
			return undefined;
		}

		const filePath = fsPath(document.uri);
		const thisFilesEdits = change.edits.filter((e) => e.file === filePath);
		const otherFilesEdits = change.edits.filter((e) => e.file !== filePath);

		if (thisFilesEdits.length) {
			completionItem.additionalTextEdits = flatMap(thisFilesEdits, (edit) => edit.edits.map((edit) => {
				const range = new vs.Range(
					document.positionAt(edit.offset),
					document.positionAt(edit.offset + edit.length),
				);
				return new vs.TextEdit(range, edit.replacement);
			}));
		}
		if (otherFilesEdits.length) {
			const filteredSourceChange: as.SourceChange = {
				edits: otherFilesEdits,
				id: change.id,
				linkedEditGroups: [],
				message: change.message,
				selection: change.selection,
			};
			completionItem.command = {
				arguments: [document, filteredSourceChange],
				command: "_dart.applySourceChange",
				title: "Automatically add imports",
			};
		}
	}

	public dispose(): any {
		disposeAll(this.disposables);
	}
}
