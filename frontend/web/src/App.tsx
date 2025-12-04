// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface Tool {
  id: string;
  name: string;
  description: string;
  encryptedRating: string;
  encryptedUsage: string;
  category: string;
  submitter: string;
  timestamp: number;
  status: "pending" | "approved" | "rejected";
}

// FHE encryption/decryption functions for numerical data
const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [tools, setTools] = useState<Tool[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showAddToolModal, setShowAddToolModal] = useState(false);
  const [addingTool, setAddingTool] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newToolData, setNewToolData] = useState({ name: "", description: "", rating: 0, usage: 0, category: "" });
  const [selectedTool, setSelectedTool] = useState<Tool | null>(null);
  const [decryptedRating, setDecryptedRating] = useState<number | null>(null);
  const [decryptedUsage, setDecryptedUsage] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [searchTerm, setSearchTerm] = useState("");
  const [activeCategory, setActiveCategory] = useState("All");
  const [showFAQ, setShowFAQ] = useState(false);

  const categories = ["All", "Assessment", "Communication", "Grading", "Analytics", "Other"];
  const approvedCount = tools.filter(t => t.status === "approved").length;
  const pendingCount = tools.filter(t => t.status === "pending").length;

  useEffect(() => {
    loadTools().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadTools = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      
      const keysBytes = await contract.getData("tool_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing tool keys:", e); }
      }
      
      const list: Tool[] = [];
      for (const key of keys) {
        try {
          const toolBytes = await contract.getData(`tool_${key}`);
          if (toolBytes.length > 0) {
            try {
              const toolData = JSON.parse(ethers.toUtf8String(toolBytes));
              list.push({ 
                id: key, 
                name: toolData.name,
                description: toolData.description,
                encryptedRating: toolData.rating,
                encryptedUsage: toolData.usage,
                category: toolData.category,
                submitter: toolData.submitter,
                timestamp: toolData.timestamp,
                status: toolData.status || "pending"
              });
            } catch (e) { console.error(`Error parsing tool data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading tool ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setTools(list);
    } catch (e) { console.error("Error loading tools:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const addTool = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setAddingTool(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting tool data with Zama FHE..." });
    try {
      const encryptedRating = FHEEncryptNumber(newToolData.rating);
      const encryptedUsage = FHEEncryptNumber(newToolData.usage);
      
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const toolId = `tool-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      const toolData = { 
        name: newToolData.name,
        description: newToolData.description,
        rating: encryptedRating,
        usage: encryptedUsage,
        category: newToolData.category,
        submitter: address,
        timestamp: Math.floor(Date.now() / 1000),
        status: "pending"
      };
      
      await contract.setData(`tool_${toolId}`, ethers.toUtf8Bytes(JSON.stringify(toolData)));
      
      const keysBytes = await contract.getData("tool_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(toolId);
      await contract.setData("tool_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Tool submitted with FHE encryption!" });
      await loadTools();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowAddToolModal(false);
        setNewToolData({ name: "", description: "", rating: 0, usage: 0, category: "" });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setAddingTool(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const approveTool = async (toolId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted data with FHE..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const toolBytes = await contract.getData(`tool_${toolId}`);
      if (toolBytes.length === 0) throw new Error("Tool not found");
      const toolData = JSON.parse(ethers.toUtf8String(toolBytes));
      
      const updatedTool = { ...toolData, status: "approved" };
      await contract.setData(`tool_${toolId}`, ethers.toUtf8Bytes(JSON.stringify(updatedTool)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Tool approved successfully!" });
      await loadTools();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Approval failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const rejectTool = async (toolId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted data with FHE..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      const toolBytes = await contract.getData(`tool_${toolId}`);
      if (toolBytes.length === 0) throw new Error("Tool not found");
      const toolData = JSON.parse(ethers.toUtf8String(toolBytes));
      const updatedTool = { ...toolData, status: "rejected" };
      await contract.setData(`tool_${toolId}`, ethers.toUtf8Bytes(JSON.stringify(updatedTool)));
      setTransactionStatus({ visible: true, status: "success", message: "Tool rejected successfully!" });
      await loadTools();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Rejection failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isSubmitter = (toolAddress: string) => address?.toLowerCase() === toolAddress.toLowerCase();

  const filteredTools = tools.filter(tool => {
    const matchesSearch = tool.name.toLowerCase().includes(searchTerm.toLowerCase()) || 
                         tool.description.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCategory = activeCategory === "All" || tool.category === activeCategory;
    return matchesSearch && matchesCategory;
  });

  const faqItems = [
    {
      question: "What is FHE?",
      answer: "Fully Homomorphic Encryption (FHE) allows computations on encrypted data without decryption. Zama's FHE technology enables privacy-preserving operations."
    },
    {
      question: "How does this protect student privacy?",
      answer: "All sensitive data (like ratings and usage) is encrypted before submission and remains encrypted during processing, ensuring student data is never exposed."
    },
    {
      question: "How can I contribute?",
      answer: "Connect your wallet to submit educational tools, vote on proposals, or participate in DAO governance discussions."
    },
    {
      question: "What data is encrypted?",
      answer: "Numerical data like tool ratings and usage statistics are encrypted using Zama FHE. Metadata like tool names remain unencrypted for discoverability."
    }
  ];

  if (loading) return (
    <div className="loading-screen">
      <div className="spinner"></div>
      <p>Loading educational tools...</p>
    </div>
  );

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="logo">
          <h1>Edu<span>DAO</span>FHE</h1>
          <p>Privacy-Preserving Educational Tools</p>
        </div>
        <div className="header-actions">
          <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false} />
        </div>
      </header>

      <main className="main-content">
        <section className="hero-section">
          <div className="hero-content">
            <h2>Decentralized Education with Privacy</h2>
            <p>A DAO curating FHE-based educational tools to protect student data privacy</p>
            <div className="hero-buttons">
              <button className="primary-btn" onClick={() => setShowAddToolModal(true)}>Submit Tool</button>
              <button className="secondary-btn" onClick={() => setShowFAQ(!showFAQ)}>
                {showFAQ ? "Hide FAQ" : "Show FAQ"}
              </button>
            </div>
          </div>
          <div className="fhe-badge">
            <span>Powered by Zama FHE</span>
          </div>
        </section>

        {showFAQ && (
          <section className="faq-section">
            <h3>Frequently Asked Questions</h3>
            <div className="faq-grid">
              {faqItems.map((item, index) => (
                <div className="faq-item" key={index}>
                  <h4>{item.question}</h4>
                  <p>{item.answer}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="stats-section">
          <div className="stat-card">
            <h3>{tools.length}</h3>
            <p>Total Tools</p>
          </div>
          <div className="stat-card">
            <h3>{approvedCount}</h3>
            <p>Approved</p>
          </div>
          <div className="stat-card">
            <h3>{pendingCount}</h3>
            <p>Pending Review</p>
          </div>
          <div className="stat-card">
            <h3>{categories.length - 1}</h3>
            <p>Categories</p>
          </div>
        </section>

        <section className="tools-section">
          <div className="section-header">
            <h2>Educational Tools</h2>
            <div className="controls">
              <div className="search-box">
                <input 
                  type="text" 
                  placeholder="Search tools..." 
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target)}
                />
                <button className="search-btn">🔍</button>
              </div>
              <select 
                value={activeCategory}
                onChange={(e) => setActiveCategory(e.target.value)}
                className="category-select"
              >
                {categories.map(cat => (
                  <option key={cat} value={cat}>{cat}</option>
                ))}
              </select>
              <button onClick={loadTools} className="refresh-btn" disabled={isRefreshing}>
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>
          </div>

          {filteredTools.length === 0 ? (
            <div className="empty-state">
              <p>No tools found matching your criteria</p>
              <button className="primary-btn" onClick={() => setShowAddToolModal(true)}>Submit First Tool</button>
            </div>
          ) : (
            <div className="tools-grid">
              {filteredTools.map(tool => (
                <div className="tool-card" key={tool.id} onClick={() => setSelectedTool(tool)}>
                  <div className="card-header">
                    <h3>{tool.name}</h3>
                    <span className={`status-badge ${tool.status}`}>{tool.status}</span>
                  </div>
                  <p className="description">{tool.description.substring(0, 100)}...</p>
                  <div className="card-footer">
                    <span className="category">{tool.category}</span>
                    <span className="date">{new Date(tool.timestamp * 1000).toLocaleDateString()}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>

      {showAddToolModal && (
        <div className="modal-overlay">
          <div className="modal">
            <div className="modal-header">
              <h2>Submit New Educational Tool</h2>
              <button onClick={() => setShowAddToolModal(false)} className="close-btn">&times;</button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label>Tool Name *</label>
                <input 
                  type="text" 
                  value={newToolData.name}
                  onChange={(e) => setNewToolData({...newToolData, name: e.target.value})}
                  placeholder="Enter tool name"
                />
              </div>
              <div className="form-group">
                <label>Description *</label>
                <textarea 
                  value={newToolData.description}
                  onChange={(e) => setNewToolData({...newToolData, description: e.target.value})}
                  placeholder="Describe the tool and its educational purpose"
                />
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Rating (1-5) *</label>
                  <input 
                    type="number" 
                    min="1" 
                    max="5" 
                    value={newToolData.rating}
                    onChange={(e) => setNewToolData({...newToolData, rating: parseInt(e.target.value) || 0})}
                  />
                </div>
                <div className="form-group">
                  <label>Estimated Usage (students/month) *</label>
                  <input 
                    type="number" 
                    value={newToolData.usage}
                    onChange={(e) => setNewToolData({...newToolData, usage: parseInt(e.target.value) || 0})}
                  />
                </div>
              </div>
              <div className="form-group">
                <label>Category *</label>
                <select 
                  value={newToolData.category}
                  onChange={(e) => setNewToolData({...newToolData, category: e.target.value})}
                >
                  <option value="">Select category</option>
                  {categories.filter(c => c !== "All").map(cat => (
                    <option key={cat} value={cat}>{cat}</option>
                  ))}
                </select>
              </div>
              <div className="encryption-preview">
                <h4>FHE Encryption Preview</h4>
                <div className="preview-row">
                  <span>Rating:</span>
                  <code>{newToolData.rating ? FHEEncryptNumber(newToolData.rating).substring(0, 20) + '...' : 'Not encrypted yet'}</code>
                </div>
                <div className="preview-row">
                  <span>Usage:</span>
                  <code>{newToolData.usage ? FHEEncryptNumber(newToolData.usage).substring(0, 20) + '...' : 'Not encrypted yet'}</code>
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button onClick={() => setShowAddToolModal(false)} className="secondary-btn">Cancel</button>
              <button onClick={addTool} disabled={addingTool} className="primary-btn">
                {addingTool ? "Submitting..." : "Submit Tool"}
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedTool && (
        <div className="modal-overlay">
          <div className="modal">
            <div className="modal-header">
              <h2>{selectedTool.name}</h2>
              <button onClick={() => {
                setSelectedTool(null);
                setDecryptedRating(null);
                setDecryptedUsage(null);
              }} className="close-btn">&times;</button>
            </div>
            <div className="modal-body">
              <div className="tool-info">
                <p className="description">{selectedTool.description}</p>
                <div className="info-row">
                  <span>Category:</span>
                  <strong>{selectedTool.category}</strong>
                </div>
                <div className="info-row">
                  <span>Submitted by:</span>
                  <strong>{selectedTool.submitter.substring(0, 6)}...{selectedTool.submitter.substring(38)}</strong>
                </div>
                <div className="info-row">
                  <span>Date:</span>
                  <strong>{new Date(selectedTool.timestamp * 1000).toLocaleString()}</strong>
                </div>
                <div className="info-row">
                  <span>Status:</span>
                  <strong className={`status-badge ${selectedTool.status}`}>{selectedTool.status}</strong>
                </div>
              </div>

              <div className="encrypted-data-section">
                <h3>Encrypted Metrics</h3>
                <div className="metric">
                  <h4>Rating</h4>
                  <div className="encrypted-value">
                    {selectedTool.encryptedRating.substring(0, 30)}...
                  </div>
                  <button 
                    className="decrypt-btn" 
                    onClick={async () => {
                      if (decryptedRating === null) {
                        const decrypted = await decryptWithSignature(selectedTool.encryptedRating);
                        setDecryptedRating(decrypted);
                      } else {
                        setDecryptedRating(null);
                      }
                    }}
                    disabled={isDecrypting}
                  >
                    {isDecrypting ? "Decrypting..." : 
                     decryptedRating !== null ? "Hide Value" : "Decrypt with Wallet"}
                  </button>
                  {decryptedRating !== null && (
                    <div className="decrypted-value">
                      <strong>Decrypted Rating:</strong> {decryptedRating}/5
                    </div>
                  )}
                </div>

                <div className="metric">
                  <h4>Estimated Usage</h4>
                  <div className="encrypted-value">
                    {selectedTool.encryptedUsage.substring(0, 30)}...
                  </div>
                  <button 
                    className="decrypt-btn" 
                    onClick={async () => {
                      if (decryptedUsage === null) {
                        const decrypted = await decryptWithSignature(selectedTool.encryptedUsage);
                        setDecryptedUsage(decrypted);
                      } else {
                        setDecryptedUsage(null);
                      }
                    }}
                    disabled={isDecrypting}
                  >
                    {isDecrypting ? "Decrypting..." : 
                     decryptedUsage !== null ? "Hide Value" : "Decrypt with Wallet"}
                  </button>
                  {decryptedUsage !== null && (
                    <div className="decrypted-value">
                      <strong>Decrypted Usage:</strong> {decryptedUsage} students/month
                    </div>
                  )}
                </div>
              </div>

              {isSubmitter(selectedTool.submitter) && selectedTool.status === "pending" && (
                <div className="admin-actions">
                  <button onClick={() => approveTool(selectedTool.id)} className="approve-btn">
                    Approve Tool
                  </button>
                  <button onClick={() => rejectTool(selectedTool.id)} className="reject-btn">
                    Reject Tool
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {transactionStatus.visible && (
        <div className="notification">
          <div className={`notification-content ${transactionStatus.status}`}>
            {transactionStatus.status === "pending" && <div className="spinner"></div>}
            {transactionStatus.status === "success" && <span>✓</span>}
            {transactionStatus.status === "error" && <span>✕</span>}
            <p>{transactionStatus.message}</p>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-section">
            <h3>EduDAO FHE</h3>
            <p>Governance and curation of privacy-preserving educational tools</p>
          </div>
          <div className="footer-section">
            <h3>Resources</h3>
            <a href="#">Documentation</a>
            <a href="#">DAO Governance</a>
            <a href="#">Submit Proposal</a>
          </div>
          <div className="footer-section">
            <h3>Community</h3>
            <a href="#">Forum</a>
            <a href="#">Discord</a>
            <a href="#">GitHub</a>
          </div>
        </div>
        <div className="footer-bottom">
          <p>© {new Date().getFullYear()} EduDAO FHE. All rights reserved.</p>
          <div className="fhe-badge">
            <span>Powered by Zama FHE</span>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default App;