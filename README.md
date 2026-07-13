## SAIC Custom RAG & OCR Preprocessor Plugin
A modified version of the RAG v1, preprocessor plugin for LM Studio, built for SAIC. 

This plugin intercepts incoming user messages with attachments, analyzes the available model context window, and dynamically determines the best strategy to inject or retrieve relevant document data—including an automated OCR fallback for flat or scanned PDFs.

### Key Features

#### Dynamic Context Engineering
Automatically measures your active LLM context window. Routes documents to either inject-full-content (if they easily fit) or retrieval (vector search chunking) based on a  customizable occupancy threshold.

#### Intelligent OCR Fallback 
Scans text length of ingested PDFs. If a document appears to be a flat image or scanned file, it triggers a local OCR parsing pipeline using a custom buffer wrapper.

#### Persistent Module-Scoped Cache 
Uses a global file-path-based memory map to cache extracted text across your entire chat session. Documents are parsed and OCR'd exactly once, eliminating redundant lag on subsequent conversation turns.

#### Hybrid Retrieval Engine
Combines native LM Studio document retrieval results with custom vector embeddings computed on OCR-recovered content using the Nomic embedding model.